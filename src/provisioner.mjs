/**
 * Inference provisioner: turns a ModelSpec into (1) a Vast offer query for a
 * SINGLE GPU and (2) the instance-creation body that starts Ollama.
 *
 * Ollama is served with the official `ollama/ollama` image, whose entrypoint
 * already runs `ollama serve`. Unlike vLLM, the model does NOT go in the args:
 * the machine starts EMPTY and the GGUF is pulled AFTERWARDS over HTTP
 * (POST /api/pull, see ollamaClient.pullModelStreaming). That is why the body
 * carries neither --model nor quantization: ONE image serves ANY model. We
 * expose the container's port 11434 to reach /v1 (OpenAI-compatible) and /api
 * (Ollama REST).
 */

import { resolveModelLimits } from "./models.mjs";

/** Official Ollama image (REST /api + OpenAI-compatible /v1 on port 11434). */
export const OLLAMA_IMAGE = "ollama/ollama";

/** Container port Ollama listens on (Vast publishes it on a random host port). */
export const OLLAMA_PORT = 11434;

/**
 * ABSOLUTE MINIMUM compute capability (x100) for ANY model. Modern CUDA images
 * (the ones Ollama/llama.cpp use on Vast) stopped shipping kernels for Volta
 * (sm_70 = Tesla V100/P100): the machine boots but crashes as soon as it touches
 * the GPU with `no kernel image is available for execution on the device`.
 * We require Turing+ (750) so we never rent machines that are GUARANTEED to
 * crash and burn credit. A model may ask for MORE, never less.
 */
export const MIN_COMPUTE_CAP = 750;

/** Effective compute-capability floor for a model: the greater of the global
 * floor and whatever the model itself requires. */
export function computeCapFloor(model) {
  return Math.max(MIN_COMPUTE_CAP, model.minComputeCap ?? 0);
}

/**
 * Builds the offer query for a model: a machine with EXACTLY the GPUs the model
 * uses, on ONE node, with enough total VRAM, reliable and rentable, sorted by
 * ascending price.
 * @param {import("./models.mjs").ModelSpec} model
 */
export function buildOfferQuery(model) {
  /** @type {Record<string, unknown>} */
  const q = {
    rentable: { eq: true },
    // EXACTLY the GPUs the model uses (not `gte`): asking for more means
    // (1) paying for idle cards and (2) mounting extra GPUs in the container,
    // which triggers the host's CDI bug (unregistered gpu=N indexes ->
    // "unresolvable CDI devices"). Tensor parallelism needs EXACTLY
    // tensorParallel GPUs.
    num_gpus: { eq: model.tensorParallel },
    gpu_total_ram: { gte: model.minTotalVramGb * 1024 },
    reliability2: { gt: 0.95 },
    inet_down: { gt: 200 },
    disk_space: { gte: model.diskGb },
    // Modern CUDA so that the runtime does not complain on new GPUs.
    cuda_max_good: { gte: 12 },
    order: [["dph_total", "asc"]],
    type: "on-demand",
    limit: 20,
  };
  // Budget cap: discard machines pricier than the model's limit.
  if (typeof model.maxDphTotal === "number") {
    q.dph_total = { lte: model.maxDphTotal };
  }
  // Minimum compute capability: ALWAYS Turing+ (modern CUDA images dropped
  // Volta=700). The model may require more; computeCapFloor takes the greater.
  q.compute_cap = { gte: computeCapFloor(model) };
  return q;
}

/**
 * Ranks ALL viable offers for the model, best to worst. Filters by VRAM,
 * num_gpus, budget and compute capability; sorts by closeness to
 * tensorParallel, reliability and price. Returning the full list (not just the
 * best) allows retrying with the next one when an offer evaporates (Vast
 * offers are ephemeral: between the search and the PUT, someone else can grab
 * it -> no_such_ask).
 *
 * `history.badIds`/`history.goodIds` (Sets of machineId) give the auto-pick
 * MEMORY: it EXCLUDES hosts banned after previous failures and PREFERS the ones
 * that already booted fine. The machineId is the stable physical host (the
 * offer is ephemeral).
 * @param {import("./models.mjs").ModelSpec} model
 * @param {ReturnType<import("./vastClient.mjs").mapOffer>[]} offers
 * @param {{ badIds?: Set<number>, goodIds?: Set<number> }} [history]
 */
export function rankOffers(model, offers, history = {}) {
  const badIds = history.badIds ?? new Set();
  const goodIds = history.goodIds ?? new Set();
  const viable = offers.filter(
    (o) =>
      // EXACTLY the model's GPUs: a machine with more GPUs mounts extra cards
      // in the container and risks the CDI bug (broken gpu=N indexes).
      o.numGpus === model.tensorParallel &&
      o.totalVramGb >= model.minTotalVramGb &&
      o.id > 0 &&
      // Blocklist with memory: a host that already failed is EXCLUDED (if the
      // offer carries a machineId; without one we cannot keep history, so we
      // do not discard it).
      !(typeof o.machineId === "number" && badIds.has(o.machineId)) &&
      // Respect the model's budget cap (if it defines one).
      (typeof model.maxDphTotal !== "number" ||
        o.dphTotal <= model.maxDphTotal) &&
      // Compute capability: ALWAYS Turing+ (modern CUDA images dropped
      // Volta=700). With no known computeCap we discard: renting blind a
      // V100 = guaranteed crash.
      typeof o.computeCap === "number" &&
      o.computeCap >= computeCapFloor(model),
  );
  // All viable offers already have the exact num_gpus; sort by: known-good host
  // first, then higher reliability, then lower price.
  // (gpuDiff stays as a safeguard: always 0.)
  viable.sort((a, b) => {
    const gpuDiff =
      Math.abs(a.numGpus - model.tensorParallel) -
      Math.abs(b.numGpus - model.tensorParallel);
    if (gpuDiff !== 0) return gpuDiff;
    // Allowlist with memory: a host that already booted fine is preferred over a new one.
    const aGood =
      typeof a.machineId === "number" && goodIds.has(a.machineId) ? 0 : 1;
    const bGood =
      typeof b.machineId === "number" && goodIds.has(b.machineId) ? 0 : 1;
    if (aGood !== bGood) return aGood - bGood;
    const relDiff = (b.reliability ?? 0) - (a.reliability ?? 0);
    if (Math.abs(relDiff) > 0.01) return relDiff;
    return a.dphTotal - b.dphTotal;
  });
  return viable;
}

/**
 * Picks the best offer from the list for the model. Priorities: enough VRAM,
 * exactly (or more) GPUs than tensorParallel, better reliability, lower price.
 * Returns null if none qualifies.
 * @param {import("./models.mjs").ModelSpec} model
 * @param {ReturnType<import("./vastClient.mjs").mapOffer>[]} offers
 */
export function pickBestOffer(model, offers) {
  return rankOffers(model, offers)[0] ?? null;
}

/**
 * Builds the instance-creation body that starts Ollama. The model does NOT go
 * here: the machine starts empty and the GGUF is pulled over HTTP after boot
 * (see ollamaClient.pullModelStreaming). A single image serves any model, so
 * the body is identical for the whole catalog except for the disk size.
 * @param {import("./models.mjs").ModelSpec} model
 */
export function buildInstanceBody(model) {
  return {
    client_id: "me",
    image: OLLAMA_IMAGE,
    disk: model.diskGb,
    runtype: "args",
    env: {
      // Vast publishes the container's 11434 on a random host port.
      [`-p ${OLLAMA_PORT}:${OLLAMA_PORT}`]: "1",
      // CRITICAL: by default Ollama listens on 127.0.0.1 and Vast's proxy
      // cannot reach it -> "fetch failed". We force a bind on all interfaces.
      OLLAMA_HOST: `0.0.0.0:${OLLAMA_PORT}`,
      // CRITICAL: the OpenAI-compatible endpoint (/v1) IGNORES the window the
      // client declares; Ollama serves with whatever num_ctx it had at startup
      // (default ~2048). Without this, the context is silently TRUNCATED even
      // if opencode asks for more. We pin the model's real window at boot (the
      // catalog VRAM is already sized for this KV cache).
      OLLAMA_CONTEXT_LENGTH: String(resolveModelLimits(model).context),
    },
    // The ollama/ollama image already runs `serve` as its entrypoint. No args.
    args: [],
  };
}

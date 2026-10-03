/**
 * Orphaned-instance reconciler. The rental state lives ONLY in memory
 * (`rentalStore`): if the server restarts (crash, deploy, port in use) it loses
 * track, but the Vast instance is STILL alive and billing.
 *
 * On boot, this module asks Vast which of our instances are still running and
 * RE-ADOPTS the first viable one: it rebuilds the `offer`, recovers the
 * `modelTag` by reading Ollama's own `/api/tags` (the downloaded models), and
 * leaves the store in the right phase. That way the panel shows the instance
 * again (with its real uptime timer) and the "Destroy" button can release
 * it, so no ghost instances keep burning credit.
 *
 * All decision logic is PURE (no network): `isVelocityInstance`,
 * `findAdoptableInstance` and `buildReconciledState`. Only `reconcileOrphan`
 * orchestrates the calls to Vast/Ollama.
 */

import { OLLAMA_IMAGE } from "./provisioner.mjs";
import { probeOllama, deriveOllamaPhase } from "./rentalStore.mjs";
import { MODEL_CATALOG } from "./models.mjs";

/** Vast contract states we consider "alive" (not terminated/stopped). */
const LIVE_STATES = new Set(["running", "loading", "created", "starting"]);

/**
 * Is the instance ours (created by VelocityGPU)? We identify it by the official
 * Ollama image. Without this we could adopt other people's instances on the
 * account.
 * @param {{ image?: string }} inst
 */
export function isVelocityInstance(inst) {
  if (!inst || typeof inst.image !== "string") return false;
  // Compare by repo name (without tag) to tolerate :latest / :0.5 / @sha.
  const repo = (s) => s.split("@")[0].split(":")[0];
  return repo(inst.image) === repo(OLLAMA_IMAGE);
}

/**
 * Is the contract still alive? We look at both `curState`/`intendedStatus`
 * (the Vast contract state) and `actualStatus`, because in the first seconds
 * `actual_status` comes back empty even though the machine is already
 * `running`.
 * @param {{ curState?: string, intendedStatus?: string, actualStatus?: string }} inst
 */
export function isInstanceAlive(inst) {
  if (!inst) return false;
  const signals = [inst.curState, inst.intendedStatus, inst.actualStatus];
  return signals.some((s) => typeof s === "string" && LIVE_STATES.has(s));
}

/**
 * Picks the orphaned instance to adopt from Vast's raw list: ours (Ollama
 * image) and alive. If there are several (there should not be in this
 * one-at-a-time PoC), we prefer the most recently started one (highest
 * startDate).
 * @param {Array<object>} instances
 * @returns {object | null}
 */
export function findAdoptableInstance(instances) {
  if (!Array.isArray(instances)) return null;
  const candidates = instances.filter(
    (i) => isVelocityInstance(i) && isInstanceAlive(i),
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.startDate ?? 0) - (a.startDate ?? 0));
  return candidates[0];
}

/**
 * Rebuilds the `offer` (physical host) from an adopted instance, so the
 * "It didn't work" auto-blocklist button stays anchored to the machineId.
 * @param {{ machineId?: number, gpuName?: string, numGpus?: number, dphTotal?: number, totalVramGb?: number, perGpuVramGb?: number }} inst
 */
export function offerFromInstance(inst) {
  return {
    id: 0, // the original offer no longer exists; the ephemeral id is useless now.
    machineId: inst.machineId,
    gpuName: inst.gpuName ?? "GPU",
    numGpus: inst.numGpus ?? 1,
    dphTotal: inst.dphTotal ?? 0,
    // We propagate the mapped VRAM (or undefined): the frontend renders it
    // defensively as "—" when missing, instead of the old "undefinedGB".
    totalVramGb: inst.totalVramGb,
    perGpuVramGb: inst.perGpuVramGb,
  };
}

/**
 * Builds the rental state patch for an adopted instance. It mixes the derived
 * phase (provisioning/pulling-model/ready) with the data the store needs for
 * /api/status, the chat and the timer to work: instanceId, the rebuilt offer,
 * startedAt (contract epoch in ms) and the recovered model.
 * Pure: it receives everything already queried and returns the patch.
 * @param {object} inst                 Mapped instance (mapInstance).
 * @param {{ modelTag?: string, probe?: "down"|"no-model"|"loading"|"ready" }} [extras]
 */
export function buildReconciledState(inst, extras = {}) {
  const { modelTag, probe = "down" } = extras;
  const derived = deriveOllamaPhase(inst, probe);
  /** @type {Record<string, unknown>} */
  const patch = {
    ...derived,
    instanceId: inst.id,
    offer: offerFromInstance(inst),
    recordedGood: true, // it already booted at some point: do not re-allowlist on every poll.
  };
  // startedAt anchors the uptime timer to the REAL start of the contract (epoch ms).
  if (typeof inst.startDate === "number") {
    patch.startedAt = inst.startDate * 1000;
  }
  // We recover the model from the Ollama tag reported by /api/tags, and map it
  // back to the catalog to regain the slug and the readable label.
  if (typeof modelTag === "string" && modelTag) {
    patch.modelTag = modelTag;
    const model = MODEL_CATALOG.find((m) => m.ollamaTag === modelTag);
    if (model) {
      patch.modelId = model.id;
      patch.modelLabel = model.label;
    }
  }
  return patch;
}

/**
 * Reads the models already pulled by the running Ollama (`GET /api/tags`) to
 * work out what an orphaned instance is serving. It tells 3 situations apart:
 * server down (`alive:false`), alive but no model (`alive:true, tag:undefined`)
 * and alive with a model (`alive:true, tag:"..."`). Ollama lists {models:[{name,model}]}.
 * @param {string} endpoint
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ alive: boolean, tag?: string }>}
 */
export async function probeOllamaModels(endpoint, fetchImpl) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  try {
    const res = await doFetch(`${endpoint}/api/tags`);
    if (!res.ok) {
      /* v8 ignore next -- release the socket even though we ignore the body */
      await res.text?.().catch(() => "");
      return { alive: false };
    }
    const data = await res.json().catch(() => null);
    const first = Array.isArray(data?.models) ? data.models[0] : undefined;
    const tag = first?.name ?? first?.model;
    return { alive: true, tag: typeof tag === "string" && tag ? tag : undefined };
  } catch {
    return { alive: false };
  }
}

/**
 * Orchestrates reconciliation on boot. If the store is NOT idle, it touches
 * nothing (a rental is already tracked). If it is, it asks Vast for our live
 * instances and adopts the first one: it rebuilds the state and writes it into
 * the store. Best-effort: any network failure is swallowed (and logged) so it
 * never takes down the server's startup.
 *
 * @param {{
 *   vast: { listInstances: () => Promise<object[]> },
 *   rental: { get: () => any, set: (p: object) => any },
 *   fetchImpl?: typeof fetch,
 *   logger?: { info?: Function, warn?: Function },
 * }} deps
 * @returns {Promise<{ adopted: boolean, instanceId?: number, phase?: string, modelId?: string }>}
 */
export async function reconcileOrphan(deps) {
  const { vast, rental } = deps;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const log = deps.logger ?? console;

  // We only reconcile a "clean" store: if there is already an active phase, we respect it.
  const current = rental.get();
  if (current.phase !== "idle") return { adopted: false };

  let instances;
  try {
    instances = await vast.listInstances();
  } catch (err) {
    log.warn?.(`[reconcile] could not list Vast instances (${String(err?.message ?? err)})`);
    return { adopted: false };
  }

  const inst = findAdoptableInstance(instances);
  if (!inst) return { adopted: false };

  // If there is already an endpoint, find out which model Ollama pulled and whether it answers yet.
  const endpoint =
    inst.publicIp && inst.apiPort ? `http://${inst.publicIp}:${inst.apiPort}` : undefined;
  /** @type {"down"|"no-model"|"loading"|"ready"} */
  let probe = "down";
  let modelTag;
  if (endpoint) {
    const found = await probeOllamaModels(endpoint, fetchImpl);
    if (!found.alive) {
      probe = "down";
    } else if (!found.tag) {
      probe = "no-model";
    } else {
      modelTag = found.tag;
      probe = await probeOllama(endpoint, modelTag, fetchImpl);
    }
  }

  const patch = buildReconciledState(inst, { modelTag, probe });
  rental.set(patch);
  log.info?.(
    `[reconcile] adopted instance ${inst.id} (${inst.gpuName ?? "GPU"}) ` +
      `-> phase=${patch.phase}${modelTag ? ` model=${modelTag}` : ""}`,
  );
  return { adopted: true, instanceId: inst.id, phase: patch.phase, modelId: patch.modelId };
}

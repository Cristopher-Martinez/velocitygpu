/**
 * Rental state (PoC = one instance at a time, in memory) and the phase state
 * machine so the frontend knows what to show:
 *
 *   idle → searching → provisioning → pulling-model → ready → (error)
 *
 * "pulling-model" is key and specific to Ollama: the machine starts EMPTY (the
 * ollama/ollama image ships no models). After boot we have to (1) download the
 * GGUF over HTTP and (2) load it into VRAM on the first request. Only once a
 * real generation answers 200 is the model ready to chat.
 */

/**
 * @typedef {Object} RentalState
 * @property {"idle"|"searching"|"provisioning"|"pulling-model"|"ready"|"error"} phase
 * @property {string} [modelId]    Internal catalog slug (for the UI).
 * @property {string} [modelTag]   Real Ollama tag (what gets pulled and requested on /v1).
 * @property {string} [modelLabel]
 * @property {number} [instanceId]
 * @property {object} [offer]
 * @property {string} [endpoint]   Ollama API base URL once ready.
 * @property {boolean} [pulling]   true while the background pull runs (prevents relaunching it).
 * @property {boolean} [warming]   true while the background warmup (VRAM load) runs.
 * @property {boolean} [recordedGood] true once the host was auto-allowlisted on the 1st transition to ready.
 * @property {string} [message]
 * @property {number} [startedAt]
 */

/** Creates the mutable state container for the active rental. */
export function createRentalStore() {
  /** @type {RentalState} */
  let state = { phase: "idle" };
  return {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
      return state;
    },
    reset: () => {
      state = { phase: "idle" };
      return state;
    },
  };
}

/**
 * Probes a remote Ollama and returns one of 4 states (NOT a boolean: the
 * frontend needs to tell "server starting" apart from "downloading model" and
 * from "loading into VRAM"):
 *   - "down"     : /api/tags did not answer -> the Ollama server has not started yet.
 *   - "no-model" : server alive but the model is NOT downloaded -> a pull is needed.
 *   - "loading"  : model downloaded but NOT yet resident in VRAM -> warming up.
 *   - "ready"    : model downloaded AND resident in VRAM -> ready to chat.
 *
 * Readiness by OBSERVATION, not by trial by fire: /api/tags listing the model
 * is NOT enough (it is on disk, not in VRAM). We used to force a 1-token
 * generation, but a big model's cold start takes longer than any reasonable
 * timeout, and aborting the generation CANCELLED the load in progress
 * (livelock: it never warmed up on its own). Now we query /api/ps (read-only):
 * the load is triggered by a dedicated warmup with a long timeout; here we only
 * look at whether the model has become resident.
 *
 * @param {string} endpoint
 * @param {string} modelTag
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<"down"|"no-model"|"loading"|"ready">}
 */
export async function probeOllama(endpoint, modelTag, fetchImpl) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  // 1) Is the Ollama server alive and which models has it downloaded?
  let tags;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await doFetch(`${endpoint}/api/tags`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) {
      /* v8 ignore next -- release the socket even though we ignore the body */
      await res.text().catch(() => "");
      return "down";
    }
    tags = await res.json().catch(() => null);
  } catch {
    return "down";
  }
  // 2) Is the model we want downloaded? Ollama lists {models:[{name,model}]}.
  //    The tag can look like "qwen2.5:7b" or "hf.co/...:Q4_K_M".
  const present = Array.isArray(tags?.models)
    ? tags.models.some((m) => m?.name === modelTag || m?.model === modelTag)
    : false;
  if (!present) return "no-model";
  // 3) Is the model RESIDENT in VRAM? Read-only query to /api/ps. Unlike forcing
  //    a generation (which would cancel the load in progress on timeout ->
  //    livelock), /api/ps only OBSERVES. The load is triggered by the dedicated
  //    warmup; here we only check whether it has finished.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await doFetch(`${endpoint}/api/ps`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) {
      /* v8 ignore next -- release the socket even though we ignore the body */
      await res.text().catch(() => "");
      return "loading";
    }
    const ps = await res.json().catch(() => null);
    const resident = Array.isArray(ps?.models)
      ? ps.models.some((m) => m?.name === modelTag || m?.model === modelTag)
      : false;
    return resident ? "ready" : "loading";
  } catch {
    return "loading";
  }
}

/**
 * Derives the phase from the Vast instance state + the Ollama probe. Pure: it
 * receives the already-queried data and decides the resulting phase.
 * @param {{ actualStatus?: string, apiPort?: number, publicIp?: string, statusMsg?: string }} inst
 * @param {"down"|"no-model"|"loading"|"ready"} probe
 */
export function deriveOllamaPhase(inst, probe) {
  if (!inst) return { phase: "provisioning", message: "Waiting for Vast..." };
  const running = inst.actualStatus === "running";
  const hasEndpoint = Boolean(inst.publicIp && inst.apiPort);
  if (!running || !hasEndpoint) {
    return {
      phase: "provisioning",
      message: inst.statusMsg ?? "Starting the GPU instance...",
    };
  }
  const endpoint = `http://${inst.publicIp}:${inst.apiPort}`;
  if (probe === "ready") {
    return { phase: "ready", endpoint, message: "Model loaded. Let's chat!" };
  }
  if (probe === "down") {
    // Machine running but Ollama has not answered /api/tags yet: the server is starting.
    return {
      phase: "provisioning",
      message: inst.statusMsg ?? "Machine ready, starting Ollama...",
    };
  }
  if (probe === "no-model") {
    return {
      phase: "pulling-model",
      endpoint,
      message: "Downloading the model (GGUF) to the machine...",
    };
  }
  // "loading": model downloaded, loading into VRAM on the first request.
  return {
    phase: "pulling-model",
    endpoint,
    message: "Loading the model into VRAM (first start)...",
  };
}

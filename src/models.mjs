/**
 * Curated model catalog for the PoC. Each entry describes how much VRAM a model
 * needs and which Ollama tag has to be pulled, so the provisioner can look for a
 * suitable Vast machine and the app can trigger the GGUF pull after boot.
 *
 * Golden rule of this PoC with Ollama: ONE model = ONE GPU. We serve quantized
 * GGUF files (Q4_K_M) that fit on a single card, so there is no multi-GPU
 * tensor parallelism; `tensorParallel` stays at 1 for the whole catalog.
 *
 * Estimated VRAM ~ Q4 GGUF size + KV cache + overhead. We round up to leave
 * headroom for the context window.
 */

/**
 * @typedef {Object} ModelSpec
 * @property {string} id            Internal identifier (slug).
 * @property {string} label         Display name in the UI.
 * @property {string} ollamaTag     Tag that Ollama pulls and serves (POST /api/pull, `model` in /v1).
 * @property {string} repo          Human-readable model source (for the UI card).
 * @property {"ollama"} engine      Inference engine. Always "ollama" TODAY. Dormant seam:
 *   the day a model requires another runtime (e.g. vLLM for NVFP4 on Blackwell)
 *   the value and its branch get added; until then we do NOT write dead code
 *   (YAGNI). Having the field avoids a data migration later.
 * @property {number} params        Parameters in billions (B).
 * @property {number} tensorParallel GPUs in the bundle. With GGUF on a single GPU = 1.
 * @property {number} minTotalVramGb Minimum GPU VRAM (GB).
 * @property {number} diskGb        Disk to provision (the GGUF is pulled on startup).
 * @property {boolean} gated        Reserved; the catalog tags are public.
 * @property {string} blurb         One-line pitch for the card.
 * @property {number} [minComputeCap] Minimum GPU compute capability (x100).
 *   Absent = global Turing+ floor (750), which llama.cpp/Ollama needs.
 * @property {number} [maxDphTotal] Offer price cap in $/h (budget).
 * @property {number} [approxDph]   Approximate price in $/h to show in the UI.
 * @property {boolean} [budget]     true if it fits the <= $1/h budget.
 * @property {number} [contextLen]  TOTAL context window. Absent = DEFAULT_CONTEXT_LEN.
 */

/**
 * Default context window when a model does not declare `contextLen`.
 * 32768 is the native size of the Qwen2.5 family without YaRN.
 */
export const DEFAULT_CONTEXT_LEN = 32768;

/**
 * Absolute cap on output tokens. A code answer rarely exceeds this, and capping
 * here guarantees that most of the window is left for the agent's INPUT
 * (system prompt + tools + history), which is what weighs the most.
 */
export const MAX_OUTPUT_TOKENS = 4096;

/**
 * Resolves a model's effective limits for clients (opencode) and for the UI.
 * `context` is the TOTAL window; `output` is a capped MINORITY of that window,
 * not half. Reason: the server requires `input + output <= context`, and
 * opencode asks for `max_tokens = output`. If we reserved half, a coding agent
 * (whose prompt easily exceeds half of a 16K window) would blow up with
 * "total tokens > context". Reserving a quarter (capped at 4096) leaves most of
 * the window for the prompt and avoids the overflow.
 *
 * @param {ModelSpec | null | undefined} model
 * @returns {{ context: number, output: number }}
 */
export function resolveModelLimits(model) {
  const context = model?.contextLen ?? DEFAULT_CONTEXT_LEN;
  const output = Math.min(MAX_OUTPUT_TOKENS, Math.floor(context / 4));
  return { context, output };
}

/** @type {ModelSpec[]} */
export const MODEL_CATALOG = [
  // -- Budget <= $1/h · a SINGLE GPU · GGUF Q4 via Ollama --
  {
    id: "qwen2_5-7b",
    label: "Qwen2.5 7B Instruct",
    ollamaTag: "qwen2.5:7b",
    repo: "ollama.com/library/qwen2.5:7b",
    engine: "ollama",
    params: 7,
    tensorParallel: 1,
    minTotalVramGb: 16,
    diskGb: 40,
    gated: false,
    budget: true,
    contextLen: 32768,
    maxDphTotal: 1.0,
    approxDph: 0.3,
    blurb: "Lightweight. 1 GPU (RTX 3090/4090). The cheapest option, ideal for validating the flow.",
  },
  {
    id: "qwen2_5-14b",
    label: "Qwen2.5 14B Instruct",
    ollamaTag: "qwen2.5:14b",
    repo: "ollama.com/library/qwen2.5:14b",
    engine: "ollama",
    params: 14,
    tensorParallel: 1,
    minTotalVramGb: 16,
    diskGb: 40,
    gated: false,
    budget: true,
    contextLen: 32768,
    maxDphTotal: 1.0,
    approxDph: 0.35,
    blurb: "14B Q4. Fits a 24GB RTX 3090/4090. Excellent quality for the price.",
  },
  {
    id: "qwen2_5-32b",
    label: "Qwen2.5 32B Instruct",
    ollamaTag: "qwen2.5:32b",
    repo: "ollama.com/library/qwen2.5:32b",
    engine: "ollama",
    params: 32,
    tensorParallel: 1,
    // GGUF Q4_K_M ~20GB + KV cache (32K) + overhead ~ 28GB. We ask for >= 28GB:
    // an RTX 3090/4090 (24GB) does NOT fit at 32K; an A6000/A40 (48GB) runs about $0.40-0.60/h.
    minTotalVramGb: 28,
    diskGb: 60,
    gated: false,
    budget: true,
    contextLen: 32768,
    maxDphTotal: 1.0,
    approxDph: 0.5,
    blurb: "32B Q4 on a SINGLE 48GB GPU (A6000/A40). 32K window.",
  },
  {
    id: "llama3_1-8b",
    label: "Llama 3.1 8B Instruct",
    ollamaTag: "llama3.1:8b",
    repo: "ollama.com/library/llama3.1:8b",
    engine: "ollama",
    params: 8,
    tensorParallel: 1,
    minTotalVramGb: 16,
    diskGb: 40,
    gated: false,
    budget: true,
    contextLen: 32768,
    maxDphTotal: 1.0,
    approxDph: 0.3,
    blurb: "Llama 3.1 8B Q4. Lightweight and versatile, 1 GPU. Native tool-calling support.",
  },
  {
    id: "gemma2-27b",
    label: "Gemma 2 27B Instruct",
    ollamaTag: "gemma2:27b",
    repo: "ollama.com/library/gemma2:27b",
    engine: "ollama",
    params: 27,
    tensorParallel: 1,
    minTotalVramGb: 24,
    diskGb: 50,
    gated: false,
    budget: true,
    // Gemma 2 has a native 8K context window.
    contextLen: 8192,
    maxDphTotal: 1.0,
    approxDph: 0.45,
    blurb: "Google's Gemma 2 27B Q4 on a single 24GB GPU. Strong at reasoning.",
  },
];

/** Looks up a model by id; null if it does not exist. */
export function findModel(id) {
  return MODEL_CATALOG.find((m) => m.id === id) ?? null;
}

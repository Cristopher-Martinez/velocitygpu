/**
 * Server-side client for talking to a remote Ollama (the Vast machine).
 *
 * Ollama starts EMPTY and the GGUF is pulled AFTERWARDS over HTTP (unlike
 * engines that load the model at boot because it goes in the launch args).
 * That pull is the only thing the server does actively after boot; the rest of
 * the lifecycle (readiness) is resolved by the reactive probe.
 *
 * Gotchas discovered while validating the spike (do NOT touch without
 * understanding them):
 *   1. `stream: true` is MANDATORY. With `stream:false` the HTTP connection
 *      stays open WITHOUT sending a single byte during the whole download
 *      (several GB = minutes), and Vast's port proxy drops idle connections ->
 *      "fetch failed". The NDJSON stream emits constant progress and keeps the
 *      connection alive.
 *   2. The whole stream must be CONSUMED until `status:"success"`. Releasing
 *      the reader early leaves the download half done.
 */

/** Maximum pull timeout. A large GGUF (30B+) over a slow connection can take a
 *  while; 20 min is generous and keeps a real hang from lasting forever. */
const PULL_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Pulls a GGUF model into the remote Ollama by streaming, and resolves once the
 * download reaches `success`. Throws if the pull fails or ends without success.
 *
 * @param {string} endpoint  Remote Ollama base URL (http://ip:port).
 * @param {string} modelTag  Ollama tag to pull (e.g. "qwen2.5:7b" or "hf.co/...:Q4_K_M").
 * @param {typeof fetch} [fetchImpl]
 * @param {(evt: { status: string, percent?: number }) => void} [onProgress]
 * @returns {Promise<void>}
 */
export async function pullModelStreaming(endpoint, modelTag, fetchImpl, onProgress) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const res = await doFetch(`${endpoint}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: modelTag, stream: true }),
    signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) {
    /* v8 ignore next -- defensive guard: only if text() rejects */
    const detail = await res.text?.().catch(() => "") ?? "";
    throw new Error(`pull ${res.status}: ${String(detail).slice(0, 200)}`);
  }

  // Consume the NDJSON: each line is a {status, completed, total} or {error}
  // event. Reading it all is what keeps the connection alive until "success".
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastStatus = "";
  let success = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue; // partial line or noise: the next one completes it
      }
      if (evt.error) throw new Error(`pull error: ${evt.error}`);
      if (evt.status && evt.status !== lastStatus) {
        lastStatus = evt.status;
        const percent =
          evt.total && evt.completed
            ? Math.round((evt.completed / evt.total) * 100)
            : undefined;
        onProgress?.({ status: evt.status, percent });
      }
      if (evt.status === "success") success = true;
    }
  }
  if (!success) throw new Error("pull finished without status 'success'.");
}

/** Warmup timeout. A large model's (30B+) cold start from disk into VRAM takes
 *  tens of seconds to minutes; 5 min covers the 31B model with margin without
 *  hanging forever if something really goes wrong. */
const WARMUP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * "Warms up" the model by forcing it into VRAM with ONE minimal generation.
 *
 * Different from the readiness probe (which only OBSERVES /api/ps): this
 * request DOES trigger the load and waits for it with a long timeout, without
 * aborting it halfway. That was the bug in the earlier scheme: the probe forced
 * a generation with a short timeout, and aborting it cancelled the load in
 * progress, so the model never finished warming up (livelock). Here the
 * responsibilities are split: warmup LOADS (long timeout, never cancelled),
 * probe OBSERVES (read-only, fast).
 *
 * `keep_alive` keeps the model resident so the user's first real chat does not
 * pay the cold start again.
 *
 * @param {string} endpoint
 * @param {string} modelTag
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<void>}
 */
export async function warmupModel(endpoint, modelTag, fetchImpl) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const res = await doFetch(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelTag,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      temperature: 0,
      keep_alive: "30m",
    }),
    signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
  });
  /* v8 ignore next -- release the socket even though we ignore the body */
  await res.text?.().catch(() => "");
  if (!res.ok) throw new Error(`warmup ${res.status}`);
}

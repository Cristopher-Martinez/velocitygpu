/**
 * PoC app: builds the HTTP request handler with its dependencies INJECTED
 * (Vast client, rental store, fetch, public directory and API key). It is
 * separate from `server.mjs` so it can be tested end to end without opening
 * ports.
 *
 * `server.mjs` only creates the real dependencies and calls listen; all the
 * logic lives here.
 */

import { readFile } from "node:fs/promises";
import { join, normalize, extname, relative, sep, isAbsolute } from "node:path";

import { MODEL_CATALOG, findModel, resolveModelLimits } from "./models.mjs";
import {
  buildOfferQuery,
  rankOffers,
  buildInstanceBody,
} from "./provisioner.mjs";
import { isStaleOfferError } from "./vastClient.mjs";
import { probeOllama, deriveOllamaPhase } from "./rentalStore.mjs";
import { pullModelStreaming, warmupModel } from "./ollamaClient.mjs";
import { syncOpencodeConfig } from "./opencodeSync.mjs";
import {
  RUNTIME_MODES,
  isDesktopMode,
  describeEnvironment,
} from "./runtime.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

export async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return {};
  }
}

/**
 * Builds the request handler with injected dependencies.
 * @param {{ vast: any, rental: any, apiKey: string, publicDir: string, fetchImpl?: typeof fetch, opencodeConfigPath?: string, syncOpencodeImpl?: typeof syncOpencodeConfig, mode?: "desktop" | "web", hostHistory?: any }} deps
 */
export function createApp(deps) {
  const { vast, rental, apiKey, publicDir, opencodeConfigPath } = deps;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const syncOpencodeImpl = deps.syncOpencodeImpl ?? syncOpencodeConfig;
  // Runtime mode: decides whether opencode auto-configuration is available.
  // Defaults to `web` (safe): we never write to disk unless running as desktop.
  const mode = deps.mode ?? RUNTIME_MODES.WEB;
  // Host history (blocklist/allowlist with memory). No-op stub when not
  // injected: the app keeps working without host memory (e.g. in tests that
  // do not exercise it).
  const hostHistory = deps.hostHistory ?? {
    getBadIds: async () => new Set(),
    getGoodIds: async () => new Set(),
    recordSuccess: async () => {},
    recordFailure: async () => {},
    read: async () => ({ good: [], bad: [] }),
    forget: async () => false,
  };

  async function serveStatic(req, res) {
    const urlPath = req.url === "/" ? "/index.html" : (req.url ?? "/");
    // We normalize AFTER joining, then require the path to sit inside publicDir
    // by segment (not by string prefix, which a sibling like `public-secrets`
    // would pass) -> 403 (path traversal). The URL is deliberately not
    // percent-decoded, so `%2e%2e` or `%5c` stay literal file names.
    const filePath = normalize(join(publicDir, urlPath));
    const rel = relative(publicDir, filePath);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    try {
      const file = await readFile(filePath);
      res.writeHead(200, {
        "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
      });
      res.end(file);
    } catch {
      sendJson(res, 404, { error: "Not found" });
    }
  }

  async function handleModels(_req, res) {
    sendJson(res, 200, {
      models: MODEL_CATALOG.map((m) => {
        // Limits are resolved on the server so the frontend does not duplicate
        // the context/output split logic. Single source: resolveModelLimits.
        const limits = resolveModelLimits(m);
        return {
          id: m.id,
          label: m.label,
          ollamaTag: m.ollamaTag,
          engine: m.engine,
          repo: m.repo,
          params: m.params,
          tensorParallel: m.tensorParallel,
          minTotalVramGb: m.minTotalVramGb,
          diskGb: m.diskGb,
          gated: m.gated,
          quantization: "gguf-q4",
          approxDph: m.approxDph,
          contextLen: limits.context,
          outputLen: limits.output,
          blurb: m.blurb,
        };
      }),
    });
  }

  async function handleAccount(_req, res) {
    if (!apiKey)
      return sendJson(res, 400, { error: "VAST_API_KEY is not configured" });
    try {
      const acct = await vast.getAccount();
      sendJson(res, 200, { balance: acct.balance, email: acct.email });
    } catch (err) {
      sendJson(res, 502, { error: String(err?.message ?? err) });
    }
  }

  async function handleRent(req, res) {
    if (!apiKey)
      return sendJson(res, 400, { error: "VAST_API_KEY is not configured" });
    const { modelId } = await readBody(req);
    const model = findModel(modelId);
    if (!model) return sendJson(res, 400, { error: "Unknown model" });
    const phase = rental.get().phase;
    if (phase !== "idle" && phase !== "error") {
      return sendJson(res, 409, {
        error: "A rental is already active. Destroy it first.",
      });
    }
    try {
      rental.set({
        phase: "searching",
        modelId: model.id,
        modelTag: model.ollamaTag,
        modelLabel: model.label,
        startedAt: Date.now(),
      });
      const offers = await vast.searchOffers(buildOfferQuery(model));
      // Host memory: exclude blocklisted hosts and prefer known-good ones.
      const [badIds, goodIds] = await Promise.all([
        hostHistory.getBadIds(),
        hostHistory.getGoodIds(),
      ]);
      const ranked = rankOffers(model, offers, { badIds, goodIds });
      if (ranked.length === 0) {
        // Tell "there were no machines" apart from "all the ones there were
        // are blocklisted".
        const allBanned =
          offers.length > 0 &&
          offers.every(
            (o) => typeof o.machineId === "number" && badIds.has(o.machineId),
          );
        const msg = allBanned
          ? "Every available machine is on your blocklist. Remove some or try again later."
          : "No offers meet the required VRAM.";
        rental.set({ phase: "error", message: msg });
        return sendJson(res, 503, { error: msg });
      }
      const body = buildInstanceBody(model);
      // Vast offers are ephemeral: if the chosen one vanished (no_such_ask)
      // between the search and the PUT, try the next one instead of aborting.
      let chosen = null;
      let newInstanceId = 0;
      let lastStaleErr = null;
      for (const offer of ranked) {
        rental.set({ phase: "provisioning", offer });
        try {
          ({ newInstanceId } = await vast.createInstance(offer.id, body));
          chosen = offer;
          break;
        } catch (err) {
          if (isStaleOfferError(err)) {
            lastStaleErr = err;
            continue; // offer vanished -> next candidate
          }
          throw err; // real error (auth, network, ...): let the outer catch handle it
        }
      }
      if (!chosen) {
        const msg = lastStaleErr
          ? "All offers were taken while we were renting. Try again."
          : "No GPU machines are available for this model right now.";
        rental.set({ phase: "error", message: msg });
        return sendJson(res, 503, { error: msg });
      }
      if (!newInstanceId) {
        rental.set({
          phase: "error",
          message: "Vast did not return an instanceId.",
        });
        return sendJson(res, 502, { error: "Failed to create the instance." });
      }
      rental.set({ instanceId: newInstanceId });
      sendJson(res, 200, {
        instanceId: newInstanceId,
        offer: chosen,
        model: {
          id: model.id,
          label: model.label,
          tensorParallel: model.tensorParallel,
        },
      });
    } catch (err) {
      rental.set({ phase: "error", message: String(err?.message ?? err) });
      sendJson(res, 502, { error: String(err?.message ?? err) });
    }
  }

  /**
   * Fires the GGUF pull in the background (fire-and-forget). It is the ONLY
   * active server-side piece after boot: the Ollama machine starts EMPTY and the
   * model has to be downloaded over HTTP. Readiness is resolved by the reactive
   * probe in handleStatus, so here we only download and, whatever happens,
   * release the `pulling` flag so a failure is retried on the next poll.
   * @param {string} endpoint
   * @param {string} modelTag
   */
  function startBackgroundPull(endpoint, modelTag) {
    pullModelStreaming(endpoint, modelTag, fetchImpl).then(
      () => rental.set({ pulling: false }),
      () => rental.set({ pulling: false }),
    );
  }

  /**
   * Fires the warmup in the background (fire-and-forget). Ollama downloads the
   * GGUF to disk on pull, but does NOT load it into VRAM until the first
   * request; that cold start takes a while (tens of seconds for 7B, minutes for
   * 30B+). The readiness probe only OBSERVES /api/ps, so we need something that
   * triggers the load without a short timeout cancelling it: that is
   * warmupModel (minimal generation with a long timeout + keep_alive). We
   * release `warming` when done so it can be retried if it failed.
   * @param {string} endpoint
   * @param {string} modelTag
   */
  function startWarmup(endpoint, modelTag) {
    warmupModel(endpoint, modelTag, fetchImpl).then(
      () => rental.set({ warming: false }),
      () => rental.set({ warming: false }),
    );
  }

  async function handleStatus(_req, res) {
    const st = rental.get();
    if (st.phase === "idle" || st.phase === "error" || !st.instanceId) {
      return sendJson(res, 200, st);
    }
    try {
      const inst = await vast.getInstance(st.instanceId);
      const endpoint =
        inst?.publicIp && inst?.apiPort
          ? `http://${inst.publicIp}:${inst.apiPort}`
          : undefined;
      // 4-state probe: tells server-starting / no-model / loading / ready apart.
      const probe = endpoint
        ? await probeOllama(endpoint, st.modelTag, fetchImpl)
        : "down";
      // Machine alive but model NOT downloaded -> fire the pull in the
      // background ONCE. The `pulling` flag prevents relaunching it on every
      // poll while it downloads.
      if (probe === "no-model" && endpoint && st.modelTag && !st.pulling) {
        rental.set({ pulling: true });
        startBackgroundPull(endpoint, st.modelTag);
      }
      // Model downloaded but not yet resident in VRAM (probe "loading"): fire
      // the warmup ONCE. The `warming` flag prevents relaunching it on every
      // poll; the probe flips to "ready" on its own once /api/ps sees the model
      // resident.
      if (probe === "loading" && endpoint && st.modelTag && !st.warming) {
        rental.set({ warming: true });
        startWarmup(endpoint, st.modelTag);
      }
      const derived = deriveOllamaPhase(inst, probe);
      // Auto-allowlist: on the FIRST transition to "ready" we record the host
      // as good (it really booted). The flag avoids re-recording on every poll.
      if (
        derived.phase === "ready" &&
        st.phase !== "ready" &&
        !st.recordedGood &&
        st.offer
      ) {
        await hostHistory.recordSuccess({
          machineId: st.offer.machineId,
          gpuName: st.offer.gpuName,
          dphTotal: st.offer.dphTotal,
        });
        derived.recordedGood = true;
      }
      const next = rental.set(derived);
      sendJson(res, 200, next);
    } catch (err) {
      sendJson(res, 200, {
        ...st,
        message: `Checking status... (${String(err?.message ?? err)})`,
      });
    }
  }

  async function handleEnvironment(_req, res) {
    sendJson(res, 200, describeEnvironment(mode));
  }

  async function handleOpencodeSync(_req, res) {
    // Capability gate: auto-writing opencode.json only makes sense on desktop.
    // In web mode the server is remote -> it would write the wrong disk.
    if (!isDesktopMode(mode)) {
      return sendJson(res, 403, {
        error:
          "Auto-configuration is only available in the desktop app. Follow the manual steps instead.",
      });
    }
    const st = rental.get();
    if (st.phase !== "ready" || !st.endpoint || !st.modelId) {
      return sendJson(res, 409, { error: "The model is not ready yet." });
    }
    if (!opencodeConfigPath) {
      return sendJson(res, 500, {
        error: "opencode.json path is not configured on the server.",
      });
    }
    try {
      const result = await syncOpencodeImpl({
        configPath: opencodeConfigPath,
        endpoint: st.endpoint,
        // The client sends `model` = Ollama tag (what /v1 expects), NOT the slug.
        modelId: st.modelTag,
        modelLabel: st.modelLabel,
        contextLen: findModel(st.modelId)?.contextLen,
      });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: String(err?.message ?? err) });
    }
  }

  async function handleDestroy(req, res) {
    const st = rental.get();
    // Auto-blocklist: if the user flags that it "did not work", we ban the host
    // before releasing it (the failure is anchored to the stable machineId).
    const { failed, reason } = await readBody(req);
    if (failed && st.offer && typeof st.offer.machineId === "number") {
      await hostHistory.recordFailure({
        machineId: st.offer.machineId,
        gpuName: st.offer.gpuName,
        reason:
          typeof reason === "string" && reason ? reason : "user_marked_failed",
      });
    }
    if (st.instanceId) {
      try {
        await vast.destroyInstance(st.instanceId);
      } catch {
        /* best-effort: if it no longer exists, reset anyway */
      }
    }
    rental.reset();
    sendJson(res, 200, { phase: "idle" });
  }

  async function handleHosts(_req, res) {
    sendJson(res, 200, await hostHistory.read());
  }

  async function handleForgetHost(req, res) {
    const { list, machineId } = await readBody(req);
    if (list !== "good" && list !== "bad") {
      return sendJson(res, 400, { error: "list must be 'good' or 'bad'." });
    }
    const removed = await hostHistory.forget(list, machineId);
    if (!removed)
      return sendJson(res, 404, { error: "That host was not in the list." });
    sendJson(res, 200, await hostHistory.read());
  }

  async function handleChat(req, res) {
    const st = rental.get();
    if (st.phase !== "ready" || !st.endpoint) {
      return sendJson(res, 409, { error: "The model is not ready yet." });
    }
    const { messages } = await readBody(req);
    if (!Array.isArray(messages) || messages.length === 0) {
      return sendJson(res, 400, { error: "messages is required" });
    }
    try {
      const upstream = await fetchImpl(`${st.endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: st.modelTag,
          messages,
          stream: true,
          temperature: 0.7,
        }),
      });
      if (!upstream.ok || !upstream.body) {
        /* v8 ignore next -- defensive guard: only if text() rejects */
        const detail = await upstream.text().catch(() => "");
        return sendJson(res, 502, {
          error: `Ollama ${upstream.status}: ${detail.slice(0, 200)}`,
        });
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
      res.end();
    } catch (err) {
      if (!res.headersSent)
        sendJson(res, 502, { error: String(err?.message ?? err) });
      else res.end();
    }
  }

  const ROUTES = {
    "GET /api/environment": handleEnvironment,
    "GET /api/models": handleModels,
    "GET /api/account": handleAccount,
    "GET /api/hosts": handleHosts,
    "POST /api/hosts/forget": handleForgetHost,
    "POST /api/rent": handleRent,
    "GET /api/status": handleStatus,
    "POST /api/opencode-sync": handleOpencodeSync,
    "POST /api/destroy": handleDestroy,
    "POST /api/chat": handleChat,
  };

  return async function handler(req, res) {
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0];
    const route = ROUTES[`${method} ${path}`];
    if (route) return route(req, res);
    if (method === "GET") return serveStatic(req, res);
    sendJson(res, 404, { error: "Not found" });
  };
}

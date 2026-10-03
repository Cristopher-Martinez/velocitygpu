import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { createApp, readBody, sendJson } from "../src/app.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PRODUCT_DIR = join(HERE, "..");
const PUBLIC_DIR = join(PRODUCT_DIR, "public");

// ── req/res mocks ────────────────────────────────────────────────────────────

function mockReq(method, url, body) {
  let buf = null;
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) buf = body;
    else if (typeof body === "string") buf = Buffer.from(body);
    else buf = Buffer.from(JSON.stringify(body));
  }
  async function* gen() {
    if (buf) yield buf;
  }
  const iterator = gen();
  return { method, url, [Symbol.asyncIterator]: () => iterator };
}

function mockRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: undefined,
    chunks: [],
    ended: false,
    headersSent: false,
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
      res.headersSent = true;
      return res;
    },
    write(c) {
      res.chunks.push(typeof c === "string" ? c : Buffer.from(c).toString());
      return true;
    },
    end(c) {
      if (c !== undefined) res.body = Buffer.isBuffer(c) ? c : String(c);
      res.ended = true;
    },
  };
  return res;
}

const json = (res) => JSON.parse(res.body);

function mockVast(overrides = {}) {
  return {
    getAccount: vi.fn(async () => ({ balance: 10, email: "a@b.c" })),
    searchOffers: vi.fn(async () => [
      { id: 1, numGpus: 1, totalVramGb: 96, reliability: 0.99, dphTotal: 1, gpuName: "X", computeCap: 800 },
    ]),
    createInstance: vi.fn(async () => ({ newInstanceId: 555 })),
    destroyInstance: vi.fn(async () => ({})),
    getInstance: vi.fn(async () => ({ actualStatus: "running", publicIp: "1.2.3.4", apiPort: 11434 })),
    ...overrides,
  };
}

function mockRental(initial = { phase: "idle" }) {
  let state = initial;
  return {
    get: () => state,
    set: vi.fn((patch) => {
      state = { ...state, ...patch };
      return state;
    }),
    reset: vi.fn(() => {
      state = { phase: "idle" };
      return state;
    }),
  };
}

function makeApp(opts = {}) {
  const vast = opts.vast ?? mockVast();
  const rental = opts.rental ?? mockRental(opts.rentalState);
  const handler = createApp({
    vast,
    rental,
    apiKey: opts.apiKey ?? "KEY",
    publicDir: opts.publicDir ?? PUBLIC_DIR,
    fetchImpl: opts.fetchImpl,
    opencodeConfigPath: opts.opencodeConfigPath,
    syncOpencodeImpl: opts.syncOpencodeImpl,
    mode: opts.mode ?? "desktop",
    hostHistory: opts.hostHistory,
  });
  return { handler, vast, rental };
}

/** Fake host-history store with spies and in-memory state. */
function mockHostHistory(overrides = {}) {
  return {
    getBadIds: vi.fn(async () => new Set()),
    getGoodIds: vi.fn(async () => new Set()),
    recordSuccess: vi.fn(async () => {}),
    recordFailure: vi.fn(async () => {}),
    read: vi.fn(async () => ({ good: [], bad: [] })),
    forget: vi.fn(async () => true),
    ...overrides,
  };
}

// ── directly exported helpers ────────────────────────────────────────────────

describe("sendJson / readBody", () => {
  it("sendJson serializes with content-length", () => {
    const res = mockRes();
    sendJson(res, 201, { ok: true });
    expect(res.statusCode).toBe(201);
    expect(res.headers["Content-Length"]).toBe(Buffer.byteLength('{"ok":true}'));
    expect(json(res)).toEqual({ ok: true });
  });

  it("readBody returns {} for an empty body", async () => {
    expect(await readBody(mockReq("POST", "/x"))).toEqual({});
  });

  it("readBody parses valid JSON", async () => {
    expect(await readBody(mockReq("POST", "/x", { a: 1 }))).toEqual({ a: 1 });
  });

  it("readBody returns {} for invalid JSON", async () => {
    expect(await readBody(mockReq("POST", "/x", "{nope"))).toEqual({});
  });
});

// ── router ───────────────────────────────────────────────────────────────────

describe("router", () => {
  it("applies method/url defaults and resolves query strings", async () => {
    const { handler } = makeApp();
    const res = mockRes();
    await handler(mockReq(undefined, "/api/models?foo=1"), res); // method ?? GET
    expect(res.statusCode).toBe(200);
  });

  it("404 for a POST to an unknown route", async () => {
    const { handler } = makeApp();
    const res = mockRes();
    await handler(mockReq("POST", "/nope"), res);
    expect(res.statusCode).toBe(404);
  });
});

// ── /api/models ──────────────────────────────────────────────────────────────

describe("GET /api/models", () => {
  it("returns the catalog", async () => {
    const { handler } = makeApp();
    const res = mockRes();
    await handler(mockReq("GET", "/api/models"), res);
    expect(res.statusCode).toBe(200);
    expect(json(res).models.length).toBeGreaterThan(0);
  });
});

// ── /api/account ─────────────────────────────────────────────────────────────

describe("GET /api/account", () => {
  it("400 without an api key", async () => {
    const { handler } = makeApp({ apiKey: "" });
    const res = mockRes();
    await handler(mockReq("GET", "/api/account"), res);
    expect(res.statusCode).toBe(400);
  });

  it("200 with the balance", async () => {
    const { handler } = makeApp();
    const res = mockRes();
    await handler(mockReq("GET", "/api/account"), res);
    expect(json(res)).toEqual({ balance: 10, email: "a@b.c" });
  });

  it("502 if Vast fails", async () => {
    const vast = mockVast({ getAccount: vi.fn(async () => { throw new Error("down"); }) });
    const { handler } = makeApp({ vast });
    const res = mockRes();
    await handler(mockReq("GET", "/api/account"), res);
    expect(res.statusCode).toBe(502);
    expect(json(res).error).toContain("down");
  });
});

// ── /api/rent ────────────────────────────────────────────────────────────────

describe("POST /api/rent", () => {
  it("400 without an api key", async () => {
    const { handler } = makeApp({ apiKey: "" });
    const res = mockRes();
    await handler(mockReq("POST", "/api/rent", { modelId: "qwen2_5-7b" }), res);
    expect(res.statusCode).toBe(400);
  });

  it("400 with an unknown model", async () => {
    const { handler } = makeApp();
    const res = mockRes();
    await handler(mockReq("POST", "/api/rent", { modelId: "nope" }), res);
    expect(res.statusCode).toBe(400);
  });

  it("409 if a rental is already active", async () => {
    const { handler } = makeApp({ rentalState: { phase: "ready" } });
    const res = mockRes();
    await handler(mockReq("POST", "/api/rent", { modelId: "qwen2_5-7b" }), res);
    expect(res.statusCode).toBe(409);
  });

  it("503 when there are no viable offers", async () => {
    const vast = mockVast({ searchOffers: vi.fn(async () => []) });
    const { handler, rental } = makeApp({ vast });
    const res = mockRes();
    await handler(mockReq("POST", "/api/rent", { modelId: "qwen2_5-7b" }), res);
    expect(res.statusCode).toBe(503);
    expect(rental.set).toHaveBeenCalledWith(expect.objectContaining({ phase: "error" }));
  });

  it("502 if Vast does not return an instanceId", async () => {
    const vast = mockVast({ createInstance: vi.fn(async () => ({ newInstanceId: 0 })) });
    const { handler } = makeApp({ vast });
    const res = mockRes();
    await handler(mockReq("POST", "/api/rent", { modelId: "qwen2_5-7b" }), res);
    expect(res.statusCode).toBe(502);
  });

  it("200 on the happy path (Ollama body, no HF token)", async () => {
    const vast = mockVast();
    const { handler, rental } = makeApp({ vast });
    const res = mockRes();
    await handler(mockReq("POST", "/api/rent", { modelId: "qwen2_5-7b" }), res);
    expect(res.statusCode).toBe(200);
    expect(json(res).instanceId).toBe(555);
    expect(rental.set).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 555 }));
    // The rental stores the Ollama tag for the later probe/pull.
    expect(rental.set).toHaveBeenCalledWith(
      expect.objectContaining({ modelTag: "qwen2.5:7b" }),
    );
    // The creation body is 100% Ollama: it exposes the port and binds 0.0.0.0.
    const body = vast.createInstance.mock.calls[0][1];
    expect(body.image).toBe("ollama/ollama");
    expect(body.env["-p 11434:11434"]).toBe("1");
    expect(body.env.OLLAMA_HOST).toBe("0.0.0.0:11434");
    // No HuggingFace secret travels in the container env anymore.
    expect(body.env.HUGGING_FACE_HUB_TOKEN).toBeUndefined();
  });

  it("502 if searchOffers throws (catch)", async () => {
    const vast = mockVast({ searchOffers: vi.fn(async () => { throw new Error("boom"); }) });
    const { handler } = makeApp({ vast });
    const res = mockRes();
    await handler(mockReq("POST", "/api/rent", { modelId: "qwen2_5-7b" }), res);
    expect(res.statusCode).toBe(502);
  });

  it("retries with the next offer when the first one vanished (no_such_ask)", async () => {
    const offers = [
      { id: 1, numGpus: 1, totalVramGb: 96, reliability: 0.99, dphTotal: 0.5, gpuName: "A", computeCap: 800 },
      { id: 2, numGpus: 1, totalVramGb: 96, reliability: 0.99, dphTotal: 0.6, gpuName: "B", computeCap: 800 },
    ];
    const createInstance = vi
      .fn()
      .mockRejectedValueOnce(new Error("Vast API /asks/1/ → 400: no_such_ask"))
      .mockResolvedValueOnce({ newInstanceId: 777 });
    const vast = mockVast({ searchOffers: vi.fn(async () => offers), createInstance });
    const { handler } = makeApp({ vast });
    const res = mockRes();
    await handler(mockReq("POST", "/api/rent", { modelId: "qwen2_5-7b" }), res);
    expect(res.statusCode).toBe(200);
    expect(json(res).instanceId).toBe(777);
    expect(createInstance).toHaveBeenCalledTimes(2);
  });

  it("503 when ALL offers vanish", async () => {
    const offers = [
      { id: 1, numGpus: 1, totalVramGb: 96, reliability: 0.99, dphTotal: 0.5, gpuName: "A", computeCap: 800 },
      { id: 2, numGpus: 1, totalVramGb: 96, reliability: 0.99, dphTotal: 0.6, gpuName: "B", computeCap: 800 },
    ];
    const createInstance = vi.fn(async () => {
      throw new Error("no_such_ask Instance type is not available.");
    });
    const vast = mockVast({ searchOffers: vi.fn(async () => offers), createInstance });
    const { handler, rental } = makeApp({ vast });
    const res = mockRes();
    await handler(mockReq("POST", "/api/rent", { modelId: "qwen2_5-7b" }), res);
    expect(res.statusCode).toBe(503);
    expect(createInstance).toHaveBeenCalledTimes(2);
    expect(rental.set).toHaveBeenCalledWith(expect.objectContaining({ phase: "error" }));
  });

  it("502 if createInstance throws a REAL error (not a vanished offer)", async () => {
    const createInstance = vi.fn(async () => { throw new Error("401 unauthorized"); });
    const vast = mockVast({ createInstance });
    const { handler } = makeApp({ vast });
    const res = mockRes();
    await handler(mockReq("POST", "/api/rent", { modelId: "qwen2_5-7b" }), res);
    expect(res.statusCode).toBe(502);
    expect(createInstance).toHaveBeenCalledTimes(1);
  });

  it("503 with a blocklist message when the only offer is banned", async () => {
    const offers = [
      { id: 1, machineId: 77, numGpus: 1, totalVramGb: 96, reliability: 0.99, dphTotal: 1, gpuName: "X", computeCap: 800 },
    ];
    const vast = mockVast({ searchOffers: vi.fn(async () => offers) });
    const hostHistory = mockHostHistory({ getBadIds: vi.fn(async () => new Set([77])) });
    const { handler, vast: v } = makeApp({ vast, hostHistory });
    const res = mockRes();
    await handler(mockReq("POST", "/api/rent", { modelId: "qwen2_5-7b" }), res);
    expect(res.statusCode).toBe(503);
    expect(json(res).error).toContain("blocklist");
    expect(v.createInstance).not.toHaveBeenCalled();
  });

  it("prefers the known-good host when ranking offers", async () => {
    const offers = [
      { id: 1, machineId: 10, numGpus: 1, totalVramGb: 96, reliability: 0.99, dphTotal: 0.5, gpuName: "cheap", computeCap: 800 },
      { id: 2, machineId: 20, numGpus: 1, totalVramGb: 96, reliability: 0.99, dphTotal: 0.9, gpuName: "good", computeCap: 800 },
    ];
    const createInstance = vi.fn(async () => ({ newInstanceId: 999 }));
    const vast = mockVast({ searchOffers: vi.fn(async () => offers), createInstance });
    const hostHistory = mockHostHistory({ getGoodIds: vi.fn(async () => new Set([20])) });
    const { handler } = makeApp({ vast, hostHistory });
    const res = mockRes();
    await handler(mockReq("POST", "/api/rent", { modelId: "qwen2_5-7b" }), res);
    expect(res.statusCode).toBe(200);
    // Despite costing more, host 20 (known-good) is rented first.
    expect(createInstance).toHaveBeenCalledWith(2, expect.anything());
  });
});

// ── /api/opencode-sync ────────────────────────────────────────────────────────
describe("GET /api/environment", () => {
  it("reports desktop + canAutoConfig true in desktop mode", async () => {
    const { handler } = makeApp({ mode: "desktop" });
    const res = mockRes();
    await handler(mockReq("GET", "/api/environment"), res);
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ mode: "desktop", canAutoConfig: true });
  });

  it("reports web + canAutoConfig false in web mode", async () => {
    const { handler } = makeApp({ mode: "web" });
    const res = mockRes();
    await handler(mockReq("GET", "/api/environment"), res);
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ mode: "web", canAutoConfig: false });
  });

  it("defaults to web when no mode is passed", async () => {
    const handler = createApp({ vast: mockVast(), rental: mockRental(), apiKey: "KEY", publicDir: PUBLIC_DIR });
    const res = mockRes();
    await handler(mockReq("GET", "/api/environment"), res);
    expect(json(res)).toEqual({ mode: "web", canAutoConfig: false });
  });
});
describe("POST /api/opencode-sync", () => {
  const READY = {
    phase: "ready",
    endpoint: "http://1.2.3.4:31739",
    modelId: "qwen2_5-32b",
    modelTag: "qwen2.5:32b",
    modelLabel: "Qwen2.5 32B",
  };

  it("409 if the model is not ready yet", async () => {
    const { handler } = makeApp({ rentalState: { phase: "pulling-model" }, opencodeConfigPath: "/c" });
    const res = mockRes();
    await handler(mockReq("POST", "/api/opencode-sync"), res);
    expect(res.statusCode).toBe(409);
  });

  it("403 in web mode: auto-config is not available", async () => {
    const syncOpencodeImpl = vi.fn();
    const { handler } = makeApp({ mode: "web", rentalState: READY, opencodeConfigPath: "/c", syncOpencodeImpl });
    const res = mockRes();
    await handler(mockReq("POST", "/api/opencode-sync"), res);
    expect(res.statusCode).toBe(403);
    expect(syncOpencodeImpl).not.toHaveBeenCalled();
  });

  it("500 if no opencode.json path is configured", async () => {
    const { handler } = makeApp({ rentalState: READY });
    const res = mockRes();
    await handler(mockReq("POST", "/api/opencode-sync"), res);
    expect(res.statusCode).toBe(500);
  });

  it("200 and returns the sync summary with the state's data", async () => {
    const syncOpencodeImpl = vi.fn(async () => ({
      path: "/c/opencode.json",
      created: false,
      providerCreated: false,
      modelAdded: true,
      baseURL: "http://1.2.3.4:31739/v1",
    }));
    const { handler } = makeApp({ rentalState: READY, opencodeConfigPath: "/c/opencode.json", syncOpencodeImpl });
    const res = mockRes();
    await handler(mockReq("POST", "/api/opencode-sync"), res);
    expect(res.statusCode).toBe(200);
    expect(json(res).modelAdded).toBe(true);
    expect(syncOpencodeImpl).toHaveBeenCalledWith({
      configPath: "/c/opencode.json",
      endpoint: READY.endpoint,
      // The sync receives the Ollama TAG as modelId (what /v1 expects).
      modelId: READY.modelTag,
      modelLabel: READY.modelLabel,
      contextLen: 32768,
    });
  });

  it("500 if the sync throws", async () => {
    const syncOpencodeImpl = vi.fn(async () => { throw new Error("disk full"); });
    const { handler } = makeApp({ rentalState: READY, opencodeConfigPath: "/c", syncOpencodeImpl });
    const res = mockRes();
    await handler(mockReq("POST", "/api/opencode-sync"), res);
    expect(res.statusCode).toBe(500);
    expect(json(res).error).toContain("disk full");
  });
});

// ── /api/status ──────────────────────────────────────────────────────────────

describe("GET /api/status", () => {
  it("returns the state as is when idle", async () => {
    const { handler } = makeApp();
    const res = mockRes();
    await handler(mockReq("GET", "/api/status"), res);
    expect(json(res).phase).toBe("idle");
  });

  it("returns the error state without querying Vast", async () => {
    const { handler, vast } = makeApp({ rentalState: { phase: "error" } });
    const res = mockRes();
    await handler(mockReq("GET", "/api/status"), res);
    expect(json(res).phase).toBe("error");
    expect(vast.getInstance).not.toHaveBeenCalled();
  });

  it("returns the state if there is no instanceId yet", async () => {
    const { handler } = makeApp({ rentalState: { phase: "provisioning" } });
    const res = mockRes();
    await handler(mockReq("GET", "/api/status"), res);
    expect(json(res).phase).toBe("provisioning");
  });

  it("ready when the instance runs and Ollama answers", async () => {
    const fetchImpl = vi.fn(async (url) =>
      url.endsWith("/api/tags")
        ? { ok: true, json: async () => ({ models: [{ name: "qwen2.5:7b", model: "qwen2.5:7b" }] }), text: async () => "" }
        : { ok: true, json: async () => ({ models: [{ name: "qwen2.5:7b", model: "qwen2.5:7b" }] }), text: async () => "" },
    );
    const { handler } = makeApp({ rentalState: { phase: "pulling-model", instanceId: 555, modelTag: "qwen2.5:7b" }, fetchImpl });
    const res = mockRes();
    await handler(mockReq("GET", "/api/status"), res);
    expect(json(res).phase).toBe("ready");
  });

  it("auto-records the host as GOOD on the first transition to ready", async () => {
    const fetchImpl = vi.fn(async (url) =>
      url.endsWith("/api/tags")
        ? { ok: true, json: async () => ({ models: [{ name: "qwen2.5:7b", model: "qwen2.5:7b" }] }), text: async () => "" }
        : { ok: true, json: async () => ({ models: [{ name: "qwen2.5:7b", model: "qwen2.5:7b" }] }), text: async () => "" },
    );
    const hostHistory = mockHostHistory();
    const { handler } = makeApp({
      rentalState: {
        phase: "pulling-model",
        instanceId: 555,
        modelTag: "qwen2.5:7b",
        offer: { machineId: 321, gpuName: "A100", dphTotal: 0.8 },
      },
      fetchImpl,
      hostHistory,
    });
    const res = mockRes();
    await handler(mockReq("GET", "/api/status"), res);
    expect(json(res).phase).toBe("ready");
    expect(hostHistory.recordSuccess).toHaveBeenCalledWith({ machineId: 321, gpuName: "A100", dphTotal: 0.8 });
  });

  it("does NOT re-record the host if it was already ready (recordedGood)", async () => {
    const fetchImpl = vi.fn(async (url) =>
      url.endsWith("/api/tags")
        ? { ok: true, json: async () => ({ models: [{ name: "qwen2.5:7b", model: "qwen2.5:7b" }] }), text: async () => "" }
        : { ok: true, json: async () => ({ models: [{ name: "qwen2.5:7b", model: "qwen2.5:7b" }] }), text: async () => "" },
    );
    const hostHistory = mockHostHistory();
    const { handler } = makeApp({
      rentalState: {
        phase: "ready",
        instanceId: 555,
        modelTag: "qwen2.5:7b",
        recordedGood: true,
        offer: { machineId: 321, gpuName: "A100" },
      },
      fetchImpl,
      hostHistory,
    });
    const res = mockRes();
    await handler(mockReq("GET", "/api/status"), res);
    expect(hostHistory.recordSuccess).not.toHaveBeenCalled();
  });

  it("pulling-model when the machine is alive but the model is not pulled yet", async () => {
    // /api/tags answers but WITHOUT the requested tag → probe "no-model" → pulling-model.
    // pulling:true keeps the status from firing a real pull on this poll.
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ models: [] }), text: async () => "" }));
    const { handler } = makeApp({
      rentalState: { phase: "pulling-model", instanceId: 555, modelTag: "qwen2.5:7b", pulling: true },
      fetchImpl,
    });
    const res = mockRes();
    await handler(mockReq("GET", "/api/status"), res);
    expect(json(res).phase).toBe("pulling-model");
  });

  it("fires the warmup when the model is pulled but not yet resident (loading)", async () => {
    // /api/tags lists the model, /api/ps does not report it resident yet → probe "loading".
    // The status must fire ONE warmup (POST /v1/chat/completions) without marking ready.
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/api/tags")) {
        return { ok: true, json: async () => ({ models: [{ name: "qwen2.5:7b" }] }), text: async () => "" };
      }
      if (url.endsWith("/api/ps")) {
        return { ok: true, json: async () => ({ models: [] }), text: async () => "" };
      }
      return { ok: true, text: async () => "" }; // /v1/chat/completions (warmup)
    });
    const { handler } = makeApp({
      rentalState: { phase: "pulling-model", instanceId: 555, modelTag: "qwen2.5:7b" },
      fetchImpl,
    });
    const res = mockRes();
    await handler(mockReq("GET", "/api/status"), res);
    expect(json(res).phase).toBe("pulling-model");
    const warmupCall = fetchImpl.mock.calls.find(([u]) => String(u).endsWith("/v1/chat/completions"));
    expect(warmupCall).toBeTruthy();
  });

  it("provisioning when the instance does not expose an endpoint yet", async () => {
    const vast = mockVast({ getInstance: vi.fn(async () => ({ actualStatus: "loading" })) });
    const { handler } = makeApp({ vast, rentalState: { phase: "provisioning", instanceId: 555 } });
    const res = mockRes();
    await handler(mockReq("GET", "/api/status"), res);
    expect(json(res).phase).toBe("provisioning");
  });

  it("does not break if getInstance throws (catch)", async () => {
    const vast = mockVast({ getInstance: vi.fn(async () => { throw new Error("api"); }) });
    const { handler } = makeApp({ vast, rentalState: { phase: "provisioning", instanceId: 555 } });
    const res = mockRes();
    await handler(mockReq("GET", "/api/status"), res);
    expect(res.statusCode).toBe(200);
    expect(json(res).message).toContain("api");
  });
});

// ── /api/destroy ─────────────────────────────────────────────────────────────

describe("POST /api/destroy", () => {
  it("destroys the instance and resets", async () => {
    const { handler, vast, rental } = makeApp({ rentalState: { phase: "ready", instanceId: 555 } });
    const res = mockRes();
    await handler(mockReq("POST", "/api/destroy"), res);
    expect(vast.destroyInstance).toHaveBeenCalledWith(555);
    expect(rental.reset).toHaveBeenCalled();
    expect(json(res)).toEqual({ phase: "idle" });
  });

  it("resets anyway if destroyInstance fails (best-effort)", async () => {
    const vast = mockVast({ destroyInstance: vi.fn(async () => { throw new Error("gone"); }) });
    const { handler, rental } = makeApp({ vast, rentalState: { phase: "ready", instanceId: 555 } });
    const res = mockRes();
    await handler(mockReq("POST", "/api/destroy"), res);
    expect(rental.reset).toHaveBeenCalled();
  });

  it("resets without calling Vast when there is no instance", async () => {
    const { handler, vast, rental } = makeApp();
    const res = mockRes();
    await handler(mockReq("POST", "/api/destroy"), res);
    expect(vast.destroyInstance).not.toHaveBeenCalled();
    expect(rental.reset).toHaveBeenCalled();
  });

  it("with failed:true it BANS the host before destroying (auto-blocklist)", async () => {
    const hostHistory = mockHostHistory();
    const { handler, vast } = makeApp({
      rentalState: { phase: "ready", instanceId: 555, offer: { machineId: 88, gpuName: "V100" } },
      hostHistory,
    });
    const res = mockRes();
    await handler(mockReq("POST", "/api/destroy", { failed: true, reason: "nvenc" }), res);
    expect(hostHistory.recordFailure).toHaveBeenCalledWith({ machineId: 88, gpuName: "V100", reason: "nvenc" });
    expect(vast.destroyInstance).toHaveBeenCalledWith(555);
  });

  it("with failed:true and no reason it uses 'user_marked_failed'", async () => {
    const hostHistory = mockHostHistory();
    const { handler } = makeApp({
      rentalState: { phase: "ready", instanceId: 555, offer: { machineId: 88 } },
      hostHistory,
    });
    const res = mockRes();
    await handler(mockReq("POST", "/api/destroy", { failed: true }), res);
    expect(hostHistory.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: 88, reason: "user_marked_failed" }),
    );
  });

  it("without failed it does NOT ban the host", async () => {
    const hostHistory = mockHostHistory();
    const { handler } = makeApp({
      rentalState: { phase: "ready", instanceId: 555, offer: { machineId: 88 } },
      hostHistory,
    });
    const res = mockRes();
    await handler(mockReq("POST", "/api/destroy", {}), res);
    expect(hostHistory.recordFailure).not.toHaveBeenCalled();
  });

  it("failed:true without a machineId in the offer does not try to ban", async () => {
    const hostHistory = mockHostHistory();
    const { handler } = makeApp({
      rentalState: { phase: "ready", instanceId: 555, offer: { gpuName: "X" } },
      hostHistory,
    });
    const res = mockRes();
    await handler(mockReq("POST", "/api/destroy", { failed: true }), res);
    expect(hostHistory.recordFailure).not.toHaveBeenCalled();
  });
});

// ── /api/hosts (host memory: blocklist/allowlist) ────────────────────────────

describe("GET /api/hosts", () => {
  it("returns the store's sorted history", async () => {
    const hostHistory = mockHostHistory({
      read: vi.fn(async () => ({
        good: [{ machineId: 1, successCount: 2 }],
        bad: [{ machineId: 9, reason: "timeout", failCount: 1 }],
      })),
    });
    const { handler } = makeApp({ hostHistory });
    const res = mockRes();
    await handler(mockReq("GET", "/api/hosts"), res);
    expect(res.statusCode).toBe(200);
    expect(json(res).good[0].machineId).toBe(1);
    expect(json(res).bad[0].machineId).toBe(9);
  });

  it("without an injected hostHistory it returns empty lists (no-op stub)", async () => {
    const { handler } = makeApp();
    const res = mockRes();
    await handler(mockReq("GET", "/api/hosts"), res);
    expect(json(res)).toEqual({ good: [], bad: [] });
  });
});

describe("POST /api/hosts/forget", () => {
  it("400 if list is neither 'good' nor 'bad'", async () => {
    const { handler } = makeApp();
    const res = mockRes();
    await handler(mockReq("POST", "/api/hosts/forget", { list: "x", machineId: 1 }), res);
    expect(res.statusCode).toBe(400);
  });

  it("404 if the host was not in the list", async () => {
    const hostHistory = mockHostHistory({ forget: vi.fn(async () => false) });
    const { handler } = makeApp({ hostHistory });
    const res = mockRes();
    await handler(mockReq("POST", "/api/hosts/forget", { list: "bad", machineId: 999 }), res);
    expect(res.statusCode).toBe(404);
  });

  it("200 and returns the updated history after removing", async () => {
    const hostHistory = mockHostHistory({
      forget: vi.fn(async () => true),
      read: vi.fn(async () => ({ good: [], bad: [] })),
    });
    const { handler } = makeApp({ hostHistory });
    const res = mockRes();
    await handler(mockReq("POST", "/api/hosts/forget", { list: "bad", machineId: 9 }), res);
    expect(res.statusCode).toBe(200);
    expect(hostHistory.forget).toHaveBeenCalledWith("bad", 9);
    expect(json(res)).toEqual({ good: [], bad: [] });
  });
});

// ── /api/chat ────────────────────────────────────────────────────────────────

function streamUpstream(chunks) {
  let i = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (i < chunks.length) {
            return { done: false, value: new TextEncoder().encode(chunks[i++]) };
          }
          return { done: true, value: undefined };
        },
      }),
    },
  };
}

describe("POST /api/chat", () => {
  const READY = { phase: "ready", endpoint: "http://gpu:11434", modelId: "qwen2_5-7b", modelTag: "qwen2.5:7b" };

  it("409 if the model is not ready", async () => {
    const { handler } = makeApp({ rentalState: { phase: "idle" } });
    const res = mockRes();
    await handler(mockReq("POST", "/api/chat", { messages: [{ role: "user", content: "hi" }] }), res);
    expect(res.statusCode).toBe(409);
  });

  it("400 if messages are missing", async () => {
    const { handler } = makeApp({ rentalState: READY });
    const res = mockRes();
    await handler(mockReq("POST", "/api/chat", {}), res);
    expect(res.statusCode).toBe(400);
  });

  it("streams Ollama's SSE", async () => {
    const fetchImpl = vi.fn(async () => streamUpstream(["data: a\n\n", "data: [DONE]\n\n"]));
    const { handler } = makeApp({ rentalState: READY, fetchImpl });
    const res = mockRes();
    await handler(mockReq("POST", "/api/chat", { messages: [{ role: "user", content: "hi" }] }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("text/event-stream");
    expect(res.chunks.join("")).toContain("[DONE]");
    expect(res.ended).toBe(true);
  });

  it("502 if Ollama answers not-ok", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, body: null, text: async () => "kaboom" }));
    const { handler } = makeApp({ rentalState: READY, fetchImpl });
    const res = mockRes();
    await handler(mockReq("POST", "/api/chat", { messages: [{ role: "user", content: "hi" }] }), res);
    expect(res.statusCode).toBe(502);
    expect(json(res).error).toContain("kaboom");
  });

  it("502 if Ollama answers without a body", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: null, text: async () => "" }));
    const { handler } = makeApp({ rentalState: READY, fetchImpl });
    const res = mockRes();
    await handler(mockReq("POST", "/api/chat", { messages: [{ role: "user", content: "hi" }] }), res);
    expect(res.statusCode).toBe(502);
  });

  it("502 if the upstream fetch throws before the headers", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const { handler } = makeApp({ rentalState: READY, fetchImpl });
    const res = mockRes();
    await handler(mockReq("POST", "/api/chat", { messages: [{ role: "user", content: "hi" }] }), res);
    expect(res.statusCode).toBe(502);
    expect(json(res).error).toContain("offline");
  });

  it("closes the stream if it fails midway (headers already sent)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read: async () => { throw new Error("mid-stream"); } }) },
    }));
    const { handler } = makeApp({ rentalState: READY, fetchImpl });
    const res = mockRes();
    await handler(mockReq("POST", "/api/chat", { messages: [{ role: "user", content: "hi" }] }), res);
    expect(res.headersSent).toBe(true);
    expect(res.ended).toBe(true);
  });
});

// ── default host-history stub (no hostHistory injected) ──────────────────────

describe("default host-history stub", () => {
  it("lets the first transition to ready complete without a store", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ models: [{ name: "qwen2.5:7b", model: "qwen2.5:7b" }] }),
      text: async () => "",
    }));
    const { handler } = makeApp({
      rentalState: {
        phase: "pulling-model",
        instanceId: 555,
        modelTag: "qwen2.5:7b",
        offer: { machineId: 321, gpuName: "A100", dphTotal: 0.8 },
      },
      fetchImpl,
    });
    const res = mockRes();
    await handler(mockReq("GET", "/api/status"), res);
    expect(json(res).phase).toBe("ready");
    expect(json(res).recordedGood).toBe(true);
  });

  it("lets a failed destroy complete without a store", async () => {
    const { handler, vast } = makeApp({
      rentalState: { phase: "ready", instanceId: 555, offer: { machineId: 88, gpuName: "V100" } },
    });
    const res = mockRes();
    await handler(mockReq("POST", "/api/destroy", { failed: true }), res);
    expect(res.statusCode).toBe(200);
    expect(vast.destroyInstance).toHaveBeenCalledWith(555);
  });

  it("answers 404 when asked to forget a host", async () => {
    const { handler } = makeApp();
    const res = mockRes();
    await handler(mockReq("POST", "/api/hosts/forget", { list: "bad", machineId: 1 }), res);
    expect(res.statusCode).toBe(404);
  });
});

// ── background pull and warmup (fire-and-forget, flag-guarded) ───────────────

describe("background pull and warmup", () => {
  const STARTING = { phase: "pulling-model", instanceId: 555, modelTag: "qwen2.5:7b" };
  const tags = (models) => ({ ok: true, json: async () => ({ models }), text: async () => "" });

  it("fires ONE pull when the machine is alive but the model is missing, then releases the flag", async () => {
    const fetchImpl = vi.fn(async (url) =>
      String(url).endsWith("/api/pull") ? streamUpstream(['{"status":"success"}\n']) : tags([]),
    );
    const { handler, rental } = makeApp({ rentalState: STARTING, fetchImpl });
    const res = mockRes();
    await handler(mockReq("GET", "/api/status"), res);
    expect(rental.set).toHaveBeenCalledWith({ pulling: true });
    await vi.waitFor(() => expect(rental.set).toHaveBeenCalledWith({ pulling: false }));
    const pulls = fetchImpl.mock.calls.filter(([u]) => String(u).endsWith("/api/pull"));
    expect(pulls).toHaveLength(1);
  });

  it("releases the pulling flag when the pull fails, so the next poll retries", async () => {
    const fetchImpl = vi.fn(async (url) =>
      String(url).endsWith("/api/pull")
        ? { ok: false, status: 500, body: null, text: async () => "boom" }
        : tags([]),
    );
    const { handler, rental } = makeApp({ rentalState: STARTING, fetchImpl });
    await handler(mockReq("GET", "/api/status"), mockRes());
    await vi.waitFor(() => expect(rental.set).toHaveBeenCalledWith({ pulling: false }));
  });

  it("releases the warming flag when the warmup succeeds", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/api/tags")) return tags([{ name: "qwen2.5:7b" }]);
      if (String(url).endsWith("/api/ps")) return tags([]);
      return { ok: true, text: async () => "" }; // warmup
    });
    const { handler, rental } = makeApp({ rentalState: STARTING, fetchImpl });
    await handler(mockReq("GET", "/api/status"), mockRes());
    expect(rental.set).toHaveBeenCalledWith({ warming: true });
    await vi.waitFor(() => expect(rental.set).toHaveBeenCalledWith({ warming: false }));
  });

  it("releases the warming flag when the warmup fails", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/api/tags")) return tags([{ name: "qwen2.5:7b" }]);
      if (String(url).endsWith("/api/ps")) return tags([]);
      return { ok: false, status: 500, text: async () => "" }; // warmup fails
    });
    const { handler, rental } = makeApp({ rentalState: STARTING, fetchImpl });
    await handler(mockReq("GET", "/api/status"), mockRes());
    await vi.waitFor(() => expect(rental.set).toHaveBeenCalledWith({ warming: false }));
  });

  it("does not relaunch the pull while the pulling flag is set", async () => {
    const fetchImpl = vi.fn(async () => tags([]));
    const { handler } = makeApp({ rentalState: { ...STARTING, pulling: true }, fetchImpl });
    await handler(mockReq("GET", "/api/status"), mockRes());
    expect(fetchImpl.mock.calls.some(([u]) => String(u).endsWith("/api/pull"))).toBe(false);
  });
});

// ── static ───────────────────────────────────────────────────────────────────

describe("serveStatic", () => {
  it('serves index.html at "/"', async () => {
    const { handler } = makeApp();
    const res = mockRes();
    await handler(mockReq("GET", "/"), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("text/html");
  });

  it("serves an asset with its MIME type", async () => {
    const { handler } = makeApp();
    const res = mockRes();
    await handler(mockReq("GET", "/styles.css"), res);
    expect(res.headers["Content-Type"]).toContain("text/css");
  });

  it("uses octet-stream for unknown extensions", async () => {
    const { handler } = makeApp({ publicDir: PRODUCT_DIR });
    const res = mockRes();
    await handler(mockReq("GET", "/package.json"), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/octet-stream");
  });

  it("404 for a missing file and for an undefined url", async () => {
    const { handler } = makeApp();
    const notFound = mockRes();
    await handler(mockReq("GET", "/does-not-exist.txt"), notFound);
    expect(notFound.statusCode).toBe(404);

    const undef = mockRes();
    await handler(mockReq("GET", undefined), undef); // url ?? "/" → directory → 404
    expect(undef.statusCode).toBe(404);
  });

  it("403 on path traversal", async () => {
    const { handler } = makeApp();
    const res = mockRes();
    await handler(mockReq("GET", "/../server.mjs"), res);
    expect(res.statusCode).toBe(403);
  });
});

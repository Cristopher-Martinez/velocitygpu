/**
 * Tests for the orphaned-instance reconciler. They cover the pure logic
 * (isVelocityInstance, isInstanceAlive, findAdoptableInstance, offerFromInstance,
 * buildReconciledState), the probe of models pulled into Ollama and the
 * orchestration (reconcileOrphan) with injected dependencies, with no real
 * network or ports.
 */

import { describe, it, expect, vi } from "vitest";

import {
  isVelocityInstance,
  isInstanceAlive,
  findAdoptableInstance,
  offerFromInstance,
  buildReconciledState,
  probeOllamaModels,
  reconcileOrphan,
} from "../src/reconciler.mjs";

/** Sample mapped instance (as returned by mapInstance). */
function fakeInstance(over = {}) {
  return {
    id: 999,
    actualStatus: "running",
    curState: "running",
    intendedStatus: "running",
    statusMsg: "",
    publicIp: "1.2.3.4",
    apiPort: 11434,
    sshHost: "ssh.vast.ai",
    sshPort: 22,
    gpuName: "RTX 4090",
    numGpus: 1,
    dphTotal: 0.3,
    machineId: 12345,
    perGpuVramGb: 24,
    totalVramGb: 24,
    startDate: 1_700_000_000,
    label: "",
    image: "ollama/ollama:latest",
    ...over,
  };
}

/** fetchImpl that simulates a live Ollama with the model pulled and resident in VRAM. */
function ollamaReadyFetch(tag = "qwen2.5:7b") {
  return vi.fn(async (url) => {
    if (url.endsWith("/api/tags")) {
      return {
        ok: true,
        text: async () => "",
        json: async () => ({ models: [{ name: tag, model: tag }] }),
      };
    }
    // /api/ps → model resident in VRAM (probe "ready").
    return {
      ok: true,
      text: async () => "",
      json: async () => ({ models: [{ name: tag, model: tag }] }),
    };
  });
}

describe("isVelocityInstance", () => {
  it("recognizes the official Ollama image regardless of the tag", () => {
    expect(isVelocityInstance({ image: "ollama/ollama:latest" })).toBe(true);
    expect(isVelocityInstance({ image: "ollama/ollama:0.5.7" })).toBe(true);
    expect(isVelocityInstance({ image: "ollama/ollama@sha256:abc" })).toBe(true);
  });

  it("rejects foreign images or instances without an image", () => {
    expect(isVelocityInstance({ image: "pytorch/pytorch:latest" })).toBe(false);
    expect(isVelocityInstance({})).toBe(false);
    expect(isVelocityInstance(null)).toBe(false);
  });
});

describe("isInstanceAlive", () => {
  it("accepts any alive state signal", () => {
    expect(isInstanceAlive({ curState: "running" })).toBe(true);
    expect(isInstanceAlive({ intendedStatus: "loading" })).toBe(true);
    expect(isInstanceAlive({ actualStatus: "starting" })).toBe(true);
    expect(isInstanceAlive({ curState: "created" })).toBe(true);
  });

  it("rejects terminal or empty states", () => {
    expect(isInstanceAlive({ curState: "exited" })).toBe(false);
    expect(isInstanceAlive({})).toBe(false);
    expect(isInstanceAlive(null)).toBe(false);
  });
});

describe("findAdoptableInstance", () => {
  it("picks the most recent instance that is ours and alive", () => {
    const old = fakeInstance({ id: 1, startDate: 1000 });
    const recent = fakeInstance({ id: 2, startDate: 2000 });
    const foreign = fakeInstance({ id: 3, startDate: 9999, image: "other/thing" });
    const dead = fakeInstance({ id: 4, startDate: 9999, curState: "exited", intendedStatus: "stopped", actualStatus: "exited" });
    const chosen = findAdoptableInstance([old, foreign, dead, recent]);
    expect(chosen.id).toBe(2);
  });

  it("returns null when there are no candidates or the input is invalid", () => {
    expect(findAdoptableInstance([])).toBeNull();
    expect(findAdoptableInstance(null)).toBeNull();
    expect(findAdoptableInstance([fakeInstance({ image: "other/thing" })])).toBeNull();
  });

  it("sorts while tolerating a missing startDate (?? 0 branch)", () => {
    const noDate = fakeInstance({ id: 10, startDate: undefined });
    const withDate = fakeInstance({ id: 11, startDate: 5000 });
    expect(findAdoptableInstance([noDate, withDate]).id).toBe(11);
  });
});

describe("offerFromInstance", () => {
  it("rebuilds the offer anchored to the machineId", () => {
    const offer = offerFromInstance(
      fakeInstance({ machineId: 777, gpuName: "A100", numGpus: 2, dphTotal: 0.9, perGpuVramGb: 40, totalVramGb: 80 }),
    );
    expect(offer).toEqual({
      id: 0,
      machineId: 777,
      gpuName: "A100",
      numGpus: 2,
      dphTotal: 0.9,
      perGpuVramGb: 40,
      totalVramGb: 80,
    });
  });

  it("applies defaults when fields are missing", () => {
    const offer = offerFromInstance({ machineId: 5 });
    expect(offer).toEqual({
      id: 0,
      machineId: 5,
      gpuName: "GPU",
      numGpus: 1,
      dphTotal: 0,
      perGpuVramGb: undefined,
      totalVramGb: undefined,
    });
  });

  it("propagates an undefined totalVramGb without inventing 0 (root of the 'undefinedGB' visual bug)", () => {
    // A reconciled instance without mapped VRAM must NOT end up as "0GB" or
    // "undefinedGB": the offer carries undefined and the frontend paints it as "—".
    const offer = offerFromInstance({ machineId: 9, gpuName: "Q RTX 8000", numGpus: 1, dphTotal: 0.28 });
    expect(offer.totalVramGb).toBeUndefined();
    expect(offer.perGpuVramGb).toBeUndefined();
  });
});

describe("buildReconciledState", () => {
  it("ready: includes endpoint, recovered model, startedAt and flags", () => {
    const inst = fakeInstance();
    const patch = buildReconciledState(inst, { modelTag: "qwen2.5:7b", probe: "ready" });
    expect(patch.phase).toBe("ready");
    expect(patch.instanceId).toBe(999);
    expect(patch.startedAt).toBe(1_700_000_000 * 1000);
    expect(patch.recordedGood).toBe(true);
    expect(patch.modelTag).toBe("qwen2.5:7b");
    expect(patch.modelId).toBe("qwen2_5-7b");
    expect(patch.modelLabel).toBe("Qwen2.5 7B Instruct");
    expect(patch.offer.machineId).toBe(12345);
  });

  it("pulling-model: there is an endpoint but Ollama is still loading the model into VRAM", () => {
    const patch = buildReconciledState(fakeInstance(), { probe: "loading" });
    expect(patch.phase).toBe("pulling-model");
    expect(patch.modelId).toBeUndefined();
  });

  it("provisioning: instance with no endpoint yet", () => {
    const patch = buildReconciledState(fakeInstance({ publicIp: null, apiPort: null }));
    expect(patch.phase).toBe("provisioning");
  });

  it("keeps the modelTag but ignores the modelId if the tag is not in the catalog", () => {
    const patch = buildReconciledState(fakeInstance({ startDate: undefined }), { modelTag: "phantom:xl", probe: "ready" });
    expect(patch.startedAt).toBeUndefined();
    expect(patch.modelTag).toBe("phantom:xl");
    expect(patch.modelId).toBeUndefined();
    expect(patch.modelLabel).toBeUndefined();
  });
});

describe("probeOllamaModels", () => {
  it("returns {alive, tag} with the first pulled model", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({ models: [{ name: "qwen2.5:7b", model: "qwen2.5:7b" }] }),
    });
    expect(await probeOllamaModels("http://x:11434", fetchImpl)).toEqual({ alive: true, tag: "qwen2.5:7b" });
    expect(fetchImpl).toHaveBeenCalledWith("http://x:11434/api/tags");
  });

  it("alive:true without a tag when the server is up but no model was pulled", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, text: async () => "", json: async () => ({ models: [] }) });
    expect(await probeOllamaModels("http://x:11434", fetchImpl)).toEqual({ alive: true, tag: undefined });
  });

  it("alive:false if the response is not ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, text: async () => "boom" });
    expect(await probeOllamaModels("http://x:11434", fetchImpl)).toEqual({ alive: false });
  });

  it("broken json → alive:true without a tag; throwing fetch → alive:false", async () => {
    const badJson = vi.fn().mockResolvedValue({ ok: true, text: async () => "", json: async () => { throw new Error("bad"); } });
    expect(await probeOllamaModels("http://x:11434", badJson)).toEqual({ alive: true, tag: undefined });
    const throwing = vi.fn().mockRejectedValue(new Error("network"));
    expect(await probeOllamaModels("http://x:11434", throwing)).toEqual({ alive: false });
  });

  it("uses globalThis.fetch when no fetchImpl is injected", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({ models: [{ name: "qwen2.5:7b", model: "qwen2.5:7b" }] }),
    });
    try {
      expect(await probeOllamaModels("http://x:11434")).toEqual({ alive: true, tag: "qwen2.5:7b" });
    } finally {
      globalThis.fetch = original;
    }
  });
});

/** Minimal in-memory store that mimics createRentalStore for the tests. */
function fakeRental(initial = { phase: "idle" }) {
  let state = { ...initial };
  return {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
      return state;
    },
  };
}

describe("reconcileOrphan", () => {
  it("touches nothing if the store already has an active phase", async () => {
    const rental = fakeRental({ phase: "ready" });
    const vast = { listInstances: vi.fn() };
    const res = await reconcileOrphan({ vast, rental });
    expect(res).toEqual({ adopted: false });
    expect(vast.listInstances).not.toHaveBeenCalled();
  });

  it("adopts a ready orphan and recovers the model", async () => {
    const rental = fakeRental();
    const vast = { listInstances: vi.fn().mockResolvedValue([fakeInstance()]) };
    const fetchImpl = ollamaReadyFetch("qwen2.5:7b");
    const logger = { info: vi.fn(), warn: vi.fn() };
    const res = await reconcileOrphan({ vast, rental, fetchImpl, logger });
    expect(res.adopted).toBe(true);
    expect(res.instanceId).toBe(999);
    expect(res.phase).toBe("ready");
    expect(res.modelId).toBe("qwen2_5-7b");
    expect(rental.get().modelTag).toBe("qwen2.5:7b");
    expect(rental.get().modelLabel).toBe("Qwen2.5 7B Instruct");
    expect(logger.info).toHaveBeenCalled();
  });

  it("adopts a live orphan with no model pulled (pulling-model)", async () => {
    const rental = fakeRental();
    const vast = { listInstances: vi.fn().mockResolvedValue([fakeInstance()]) };
    // /api/tags alive but with no models → no-model → pulling-model.
    const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => "", json: async () => ({ models: [] }) }));
    const res = await reconcileOrphan({ vast, rental, fetchImpl });
    expect(res.adopted).toBe(true);
    expect(res.phase).toBe("pulling-model");
    expect(res.modelId).toBeUndefined();
  });

  it("adopts an orphan with no endpoint (provisioning) without probing Ollama", async () => {
    const rental = fakeRental();
    const inst = fakeInstance({ publicIp: null, apiPort: null });
    const vast = { listInstances: vi.fn().mockResolvedValue([inst]) };
    const fetchImpl = vi.fn();
    const res = await reconcileOrphan({ vast, rental, fetchImpl });
    expect(res.adopted).toBe(true);
    expect(res.phase).toBe("provisioning");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not adopt when there are no candidates", async () => {
    const rental = fakeRental();
    const vast = { listInstances: vi.fn().mockResolvedValue([]) };
    const res = await reconcileOrphan({ vast, rental });
    expect(res).toEqual({ adopted: false });
    expect(rental.get().phase).toBe("idle");
  });

  it("swallows a listInstances failure and does not break boot", async () => {
    const rental = fakeRental();
    const vast = { listInstances: vi.fn().mockRejectedValue(new Error("403")) };
    const logger = { warn: vi.fn() };
    const res = await reconcileOrphan({ vast, rental, logger });
    expect(res).toEqual({ adopted: false });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("without fetchImpl or logger it uses the defaults (globalThis.fetch, console)", async () => {
    const rental = fakeRental();
    const vast = { listInstances: vi.fn().mockResolvedValue([fakeInstance()]) };
    const origFetch = globalThis.fetch;
    const origInfo = console.info;
    globalThis.fetch = ollamaReadyFetch("qwen2.5:7b");
    console.info = vi.fn();
    try {
      const res = await reconcileOrphan({ vast, rental });
      expect(res.adopted).toBe(true);
      expect(res.phase).toBe("ready");
      expect(console.info).toHaveBeenCalled();
    } finally {
      globalThis.fetch = origFetch;
      console.info = origInfo;
    }
  });
});

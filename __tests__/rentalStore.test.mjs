import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRentalStore,
  deriveOllamaPhase,
  probeOllama,
} from "../src/rentalStore.mjs";

describe("createRentalStore", () => {
  it("starts idle, applies patches and resets", () => {
    const store = createRentalStore();
    expect(store.get()).toEqual({ phase: "idle" });

    store.set({ phase: "searching", modelId: "m" });
    expect(store.get()).toMatchObject({ phase: "searching", modelId: "m" });

    store.set({ instanceId: 9 });
    expect(store.get().modelId).toBe("m"); // cumulative patch
    expect(store.get().instanceId).toBe(9);

    expect(store.reset()).toEqual({ phase: "idle" });
    expect(store.get()).toEqual({ phase: "idle" });
  });
});

describe("probeOllama", () => {
  afterEach(() => vi.useRealTimers());

  // Healthy fetch: /api/tags lists the model and /api/ps reports it resident in VRAM.
  const okFetch = async (url) => {
    if (url.endsWith("/api/tags")) {
      return {
        ok: true,
        json: async () => ({ models: [{ name: "qwen2.5:7b", model: "qwen2.5:7b" }] }),
        text: async () => "",
      };
    }
    // /api/ps → model resident in VRAM.
    return {
      ok: true,
      json: async () => ({ models: [{ name: "qwen2.5:7b", model: "qwen2.5:7b" }] }),
      text: async () => "",
    };
  };

  it("'ready' when the model is pulled AND /api/ps reports it resident in VRAM", async () => {
    expect(await probeOllama("http://x", "qwen2.5:7b", okFetch)).toBe("ready");
  });

  it("'down' when /api/tags answers not-ok", async () => {
    const fetchImpl = async () => ({ ok: false, text: async () => "" });
    expect(await probeOllama("http://x", "qwen2.5:7b", fetchImpl)).toBe("down");
  });

  it("'down' when fetch throws (server has not started yet)", async () => {
    const fetchImpl = async () => {
      throw new Error("net");
    };
    expect(await probeOllama("http://x", "qwen2.5:7b", fetchImpl)).toBe("down");
  });

  it("'no-model' when the server is alive but the model is not pulled", async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ models: [{ name: "other:7b" }] }),
      text: async () => "",
    });
    expect(await probeOllama("http://x", "qwen2.5:7b", fetchImpl)).toBe("no-model");
  });

  it("'no-model' when /api/tags carries no models array", async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({}),
      text: async () => "",
    });
    expect(await probeOllama("http://x", "qwen2.5:7b", fetchImpl)).toBe("no-model");
  });

  it("'loading' when the model is pulled but /api/ps does not report it resident yet (cold start)", async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          json: async () => ({ models: [{ name: "qwen2.5:7b" }] }),
          text: async () => "",
        };
      }
      // /api/ps → no resident models yet → still loading into VRAM.
      return { ok: true, json: async () => ({ models: [] }), text: async () => "" };
    };
    expect(await probeOllama("http://x", "qwen2.5:7b", fetchImpl)).toBe("loading");
  });

  it("'loading' when /api/ps answers not-ok", async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          json: async () => ({ models: [{ name: "qwen2.5:7b" }] }),
          text: async () => "",
        };
      }
      return { ok: false, text: async () => "" }; // /api/ps not available yet
    };
    expect(await probeOllama("http://x", "qwen2.5:7b", fetchImpl)).toBe("loading");
  });

  it("'loading' when /api/ps throws", async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          json: async () => ({ models: [{ name: "qwen2.5:7b" }] }),
          text: async () => "",
        };
      }
      throw new Error("timeout");
    };
    expect(await probeOllama("http://x", "qwen2.5:7b", fetchImpl)).toBe("loading");
  });

  it("'no-model' when /api/tags answers ok but the body is not valid JSON", async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => {
        throw new Error("bad json");
      },
      text: async () => "",
    });
    expect(await probeOllama("http://x", "qwen2.5:7b", fetchImpl)).toBe("no-model");
  });

  it("'loading' when /api/ps answers ok but the body is not valid JSON", async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          json: async () => ({ models: [{ name: "qwen2.5:7b" }] }),
          text: async () => "",
        };
      }
      return {
        ok: true,
        json: async () => {
          throw new Error("bad json");
        },
        text: async () => "",
      };
    };
    expect(await probeOllama("http://x", "qwen2.5:7b", fetchImpl)).toBe("loading");
  });

  it("'loading' when the /api/ps timeout elapses", async () => {
    vi.useFakeTimers();
    const fetchImpl = (url, init) =>
      url.endsWith("/api/tags")
        ? Promise.resolve({
            ok: true,
            json: async () => ({ models: [{ name: "qwen2.5:7b" }] }),
            text: async () => "",
          })
        : new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("aborted")));
          });
    const p = probeOllama("http://x", "qwen2.5:7b", fetchImpl);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await p).toBe("loading");
  });

  it("matches the tag by the `model` field as well as `name`", async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          json: async () => ({ models: [{ name: "x", model: "hf.co/repo:Q4_K_M" }] }),
          text: async () => "",
        };
      }
      // /api/ps → resident, matched by `model`.
      return {
        ok: true,
        json: async () => ({ models: [{ name: "x", model: "hf.co/repo:Q4_K_M" }] }),
        text: async () => "",
      };
    };
    expect(await probeOllama("http://x", "hf.co/repo:Q4_K_M", fetchImpl)).toBe("ready");
  });

  it("'down' when the /api/tags timeout elapses", async () => {
    vi.useFakeTimers();
    const fetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const p = probeOllama("http://x", "qwen2.5:7b", fetchImpl);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await p).toBe("down");
  });

  it("uses the global fetch by default when none is injected", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) =>
      String(url).endsWith("/api/tags")
        ? {
            ok: true,
            json: async () => ({ models: [{ name: "qwen2.5:7b" }] }),
            text: async () => "",
          }
        : { ok: true, json: async () => ({ models: [{ name: "qwen2.5:7b" }] }), text: async () => "" };
    try {
      expect(await probeOllama("http://x", "qwen2.5:7b")).toBe("ready");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("deriveOllamaPhase", () => {
  it("provisioning when there is no instance", () => {
    expect(deriveOllamaPhase(null, "down")).toMatchObject({ phase: "provisioning" });
  });

  it("ready when it is running, has an endpoint and the probe said 'ready'", () => {
    const r = deriveOllamaPhase(
      { actualStatus: "running", publicIp: "1.2.3.4", apiPort: 11434 },
      "ready",
    );
    expect(r).toMatchObject({ phase: "ready", endpoint: "http://1.2.3.4:11434" });
  });

  it("pulling-model when the model is not pulled yet ('no-model')", () => {
    const r = deriveOllamaPhase(
      { actualStatus: "running", publicIp: "1.2.3.4", apiPort: 11434 },
      "no-model",
    );
    expect(r).toMatchObject({ phase: "pulling-model", endpoint: "http://1.2.3.4:11434" });
    expect(typeof r.message).toBe("string");
  });

  it("pulling-model when the model is being loaded into VRAM ('loading')", () => {
    const r = deriveOllamaPhase(
      { actualStatus: "running", publicIp: "1.2.3.4", apiPort: 11434 },
      "loading",
    );
    expect(r.phase).toBe("pulling-model");
    expect(typeof r.message).toBe("string");
  });

  it("provisioning when the machine runs but Ollama has not answered yet ('down')", () => {
    const withMsg = deriveOllamaPhase(
      { actualStatus: "running", publicIp: "1.2.3.4", apiPort: 11434, statusMsg: "starting ollama" },
      "down",
    );
    expect(withMsg).toMatchObject({ phase: "provisioning", message: "starting ollama" });
  });

  it("provisioning when it is not running yet or the endpoint is missing", () => {
    const withMsg = deriveOllamaPhase({ actualStatus: "loading", statusMsg: "starting" }, "down");
    expect(withMsg).toMatchObject({ phase: "provisioning", message: "starting" });

    const noMsg = deriveOllamaPhase({ actualStatus: "running" }, "down"); // no endpoint
    expect(noMsg.phase).toBe("provisioning");
    expect(typeof noMsg.message).toBe("string");
  });
});

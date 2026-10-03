import { describe, expect, it, vi } from "vitest";
import { pullModelStreaming, warmupModel } from "../src/ollamaClient.mjs";

/** Fake fetch response whose body streams the given string chunks (NDJSON). */
function ndjsonResponse(chunks) {
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: new TextEncoder().encode(chunks[i++]) }
            : { done: true, value: undefined },
      }),
    },
  };
}

describe("pullModelStreaming", () => {
  it("POSTs a streaming pull and resolves once the stream reports success", async () => {
    const fetchImpl = vi.fn(async () =>
      ndjsonResponse([
        '{"status":"pulling manifest"}\n',
        '{"status":"downloading","completed":50,"total":100}\n{"status":"downloading","completed":100,"total":100}\n',
        '{"status":"success"}\n',
      ]),
    );
    const onProgress = vi.fn();
    await expect(
      pullModelStreaming("http://x", "qwen2.5:7b", fetchImpl, onProgress),
    ).resolves.toBeUndefined();

    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://x/api/pull");
    expect(opts.method).toBe("POST");
    // stream:true is mandatory: a silent connection gets dropped by Vast's port proxy.
    expect(JSON.parse(opts.body)).toEqual({ name: "qwen2.5:7b", stream: true });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    // Progress is reported once per distinct status, with the first percent seen.
    expect(onProgress.mock.calls.map(([evt]) => evt)).toEqual([
      { status: "pulling manifest", percent: undefined },
      { status: "downloading", percent: 50 },
      { status: "success", percent: undefined },
    ]);
  });

  it("reassembles lines split across chunks and skips blank lines and noise", async () => {
    const fetchImpl = vi.fn(async () =>
      ndjsonResponse([
        '{"status":"downl',
        'oading","completed":1,"total":4}\n\n',
        "not json\n",
        '{"status":"success"}\n',
      ]),
    );
    const onProgress = vi.fn();
    await pullModelStreaming("http://x", "m", fetchImpl, onProgress);
    expect(onProgress.mock.calls.map(([evt]) => evt)).toEqual([
      { status: "downloading", percent: 25 },
      { status: "success", percent: undefined },
    ]);
  });

  it("works without a progress callback and falls back to the global fetch", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ndjsonResponse(['{"status":"success"}\n']));
    try {
      await expect(pullModelStreaming("http://x", "m")).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("throws with the status and a truncated detail when the response is not ok", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      body: null,
      text: async () => "x".repeat(300),
    }));
    await expect(pullModelStreaming("http://x", "m", fetchImpl)).rejects.toThrow(
      /^pull 500: x{200}$/,
    );
  });

  it("throws when the response has no body, even without a text() method", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 502, body: null }));
    await expect(pullModelStreaming("http://x", "m", fetchImpl)).rejects.toThrow(
      "pull 502: ",
    );
  });

  it("throws when the stream carries an error event", async () => {
    const fetchImpl = vi.fn(async () =>
      ndjsonResponse(['{"status":"pulling manifest"}\n', '{"error":"disk full"}\n']),
    );
    await expect(pullModelStreaming("http://x", "m", fetchImpl)).rejects.toThrow(
      "pull error: disk full",
    );
  });

  it("throws when the stream ends without a success status", async () => {
    const fetchImpl = vi.fn(async () =>
      ndjsonResponse(['{"status":"downloading","completed":1,"total":2}\n']),
    );
    await expect(pullModelStreaming("http://x", "m", fetchImpl)).rejects.toThrow(
      /without status 'success'/,
    );
  });
});

describe("warmupModel", () => {
  it("POSTs to /v1/chat/completions with keep_alive and resolves when the response is ok", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => "" }));
    await expect(warmupModel("http://x", "qwen2.5:7b", fetchImpl)).resolves.toBeUndefined();

    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://x/v1/chat/completions");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("qwen2.5:7b");
    expect(body.max_tokens).toBe(1);
    expect(body.keep_alive).toBeTruthy(); // keeps the model resident after warming up
  });

  it("throws if the response is not ok", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, text: async () => "" }));
    await expect(warmupModel("http://x", "qwen2.5:7b", fetchImpl)).rejects.toThrow(/warmup/);
  });
});

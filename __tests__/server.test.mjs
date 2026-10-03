import { afterEach, describe, expect, it, vi } from "vitest";

import { startServer } from "../server.mjs";

function onceListening(server) {
  return new Promise((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe("startServer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts, serves /api/models and warns when the api key is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const server = startServer({ port: 0, apiKey: "" });
    try {
      await onceListening(server);
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}/api/models`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.models)).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it("does not warn when the api key is present", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    // With a key, boot reconciliation queries Vast: keep that call off the network.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    const server = startServer({ port: 0, apiKey: "KEY" });
    try {
      await onceListening(server);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });
});

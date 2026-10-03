import { describe, expect, it } from "vitest";

import {
  normalizeMachineId,
  mergeSuccess,
  mergeFailure,
  mergeForget,
  toSortedHistory,
  idSetFrom,
  createHostHistoryStore,
} from "../src/hostHistory.mjs";

// ── In-memory fake FS: a single file, never touches disk ─────────────────────
function makeFakeFs(initial) {
  const files = new Map();
  if (initial !== undefined) files.set("/fake/host-history.json", initial);
  const mkdirCalls = [];
  return {
    files,
    mkdirCalls,
    readFileImpl: async (path) => {
      if (!files.has(path)) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return files.get(path);
    },
    writeFileImpl: async (path, data) => {
      files.set(path, data);
    },
    mkdirImpl: async (dir, opts) => {
      mkdirCalls.push({ dir, opts });
    },
  };
}

const makeStore = (fake) =>
  createHostHistoryStore({
    filePath: "/fake/host-history.json",
    readFileImpl: fake.readFileImpl,
    writeFileImpl: fake.writeFileImpl,
    mkdirImpl: fake.mkdirImpl,
  });

describe("normalizeMachineId", () => {
  it("accepts finite positive numbers", () => {
    expect(normalizeMachineId(42)).toBe(42);
    expect(normalizeMachineId("100")).toBe(100);
  });
  it("rejects invalid values → null", () => {
    expect(normalizeMachineId(0)).toBeNull();
    expect(normalizeMachineId(-5)).toBeNull();
    expect(normalizeMachineId("abc")).toBeNull();
    expect(normalizeMachineId(undefined)).toBeNull();
    expect(normalizeMachineId(Infinity)).toBeNull();
  });
});

describe("mergeSuccess (pure)", () => {
  it("records a good host and increments the counter", () => {
    const h1 = mergeSuccess(
      { good: {}, bad: {} },
      { machineId: 1, gpuName: "A100", dphTotal: 0.9 },
      1000,
    );
    expect(h1.good[1]).toMatchObject({
      machineId: 1,
      gpuName: "A100",
      successCount: 1,
      firstSuccessAt: 1000,
    });
    const h2 = mergeSuccess(h1, { machineId: 1 }, 2000);
    expect(h2.good[1].successCount).toBe(2);
    expect(h2.good[1].firstSuccessAt).toBe(1000); // preserved
    expect(h2.good[1].lastSuccessAt).toBe(2000);
    expect(h2.good[1].gpuName).toBe("A100"); // inherited from the previous entry
  });

  it("redeems: a host that boots fine leaves the blocklist", () => {
    const start = {
      good: {},
      bad: { 7: { machineId: 7, reason: "x", failCount: 1 } },
    };
    const next = mergeSuccess(start, { machineId: 7 }, 1000);
    expect(next.bad[7]).toBeUndefined();
    expect(next.good[7].successCount).toBe(1);
  });

  it("ignores hosts without a valid machineId", () => {
    const start = { good: {}, bad: {} };
    expect(mergeSuccess(start, { machineId: 0 })).toBe(start);
  });
});

describe("mergeFailure (pure)", () => {
  it("adds a host to the blocklist and accumulates failures", () => {
    const h1 = mergeFailure(
      { good: {}, bad: {} },
      { machineId: 9, gpuName: "V100", reason: "timeout" },
      500,
    );
    expect(h1.bad[9]).toMatchObject({
      machineId: 9,
      reason: "timeout",
      failCount: 1,
      firstFailAt: 500,
    });
    const h2 = mergeFailure(h1, { machineId: 9, reason: "nvenc" }, 900);
    expect(h2.bad[9].failCount).toBe(2);
    expect(h2.bad[9].reason).toBe("nvenc");
    expect(h2.bad[9].firstFailAt).toBe(500);
  });

  it("uses 'unknown' when no reason is given", () => {
    const h = mergeFailure({ good: {}, bad: {} }, { machineId: 3 });
    expect(h.bad[3].reason).toBe("unknown");
  });

  it("ignores hosts without a valid machineId", () => {
    const start = { good: {}, bad: {} };
    expect(mergeFailure(start, { machineId: -1, reason: "x" })).toBe(start);
  });
});

describe("mergeForget (pure)", () => {
  it("removes a host from the given list", () => {
    const start = {
      good: { 1: { machineId: 1 } },
      bad: { 2: { machineId: 2 } },
    };
    const { history, removed } = mergeForget(start, "bad", 2);
    expect(removed).toBe(true);
    expect(history.bad[2]).toBeUndefined();
    expect(history.good[1]).toBeDefined();
  });

  it("removed=false when the host was not there", () => {
    const start = { good: {}, bad: {} };
    expect(mergeForget(start, "bad", 99).removed).toBe(false);
  });

  it("removed=false with an invalid machineId", () => {
    const start = { good: {}, bad: { 2: { machineId: 2 } } };
    expect(mergeForget(start, "bad", 0).removed).toBe(false);
  });
});

describe("toSortedHistory / idSetFrom (pure)", () => {
  const raw = {
    good: {
      1: { machineId: 1, successCount: 1, lastSuccessAt: 10 },
      2: { machineId: 2, successCount: 3, lastSuccessAt: 20 },
    },
    bad: {
      5: { machineId: 5, lastFailAt: 100 },
      6: { machineId: 6, lastFailAt: 300 },
    },
  };
  it("sorts good hosts by success count desc and bad hosts by most recent failure", () => {
    const { good, bad } = toSortedHistory(raw);
    expect(good.map((h) => h.machineId)).toEqual([2, 1]);
    expect(bad.map((h) => h.machineId)).toEqual([6, 5]);
  });
  it("idSetFrom returns the machineIds of a list", () => {
    expect([...idSetFrom(raw, "bad")].sort()).toEqual([5, 6]);
    expect([...idSetFrom(raw, "good")].sort()).toEqual([1, 2]);
  });
  it("tolerates empty/missing history", () => {
    expect(toSortedHistory(undefined)).toEqual({ good: [], bad: [] });
    expect(idSetFrom(undefined, "bad").size).toBe(0);
  });
});

describe("defensive branches (nullish/missing)", () => {
  it("toSortedHistory tolerates hosts without counters or timestamps", () => {
    const raw = {
      good: { 1: { machineId: 1 }, 2: { machineId: 2 } },
      bad: { 5: { machineId: 5 }, 6: { machineId: 6 } },
    };
    const { good, bad } = toSortedHistory(raw);
    expect(good.map((h) => h.machineId).sort()).toEqual([1, 2]);
    expect(bad.map((h) => h.machineId).sort()).toEqual([5, 6]);
  });

  it("idSetFrom returns an empty set for a nonexistent list", () => {
    expect(idSetFrom({ good: {}, bad: {} }, "good").size).toBe(0);
  });

  it("mergeForget tolerates undefined history (no good/bad)", () => {
    const { history, removed } = mergeForget(undefined, "bad", 1);
    expect(removed).toBe(false);
    expect(history).toEqual({ good: {}, bad: {} });
  });

  it("mergeSuccess tolerates history without good/bad defined", () => {
    const next = mergeSuccess({}, { machineId: 1 }, 1000);
    expect(next.good[1].successCount).toBe(1);
    expect(next.bad).toEqual({});
  });

  it("mergeFailure tolerates history without good/bad defined", () => {
    const next = mergeFailure({}, { machineId: 1, reason: "x" }, 1000);
    expect(next.bad[1].failCount).toBe(1);
    expect(next.good).toEqual({});
  });
});

describe("createHostHistoryStore (injected IO)", () => {
  it("starts empty when the file does not exist (ENOENT)", async () => {
    const store = makeStore(makeFakeFs());
    expect(await store.read()).toEqual({ good: [], bad: [] });
    expect((await store.getBadIds()).size).toBe(0);
  });

  it("persists a success and reads it back + creates the directory", async () => {
    const fake = makeFakeFs();
    const store = makeStore(fake);
    await store.recordSuccess({ machineId: 1, gpuName: "A100", dphTotal: 0.8 });
    expect(fake.mkdirCalls[0].opts).toEqual({ recursive: true });
    const { good } = await store.read();
    expect(good).toHaveLength(1);
    expect(good[0]).toMatchObject({
      machineId: 1,
      gpuName: "A100",
      successCount: 1,
    });
    expect([...(await store.getGoodIds())]).toEqual([1]);
  });

  it("persists a failure → it shows up in getBadIds", async () => {
    const fake = makeFakeFs();
    const store = makeStore(fake);
    await store.recordFailure({ machineId: 42, reason: "timeout" });
    expect([...(await store.getBadIds())]).toEqual([42]);
  });

  it("recordSuccess redeems a banned host on disk", async () => {
    const fake = makeFakeFs();
    const store = makeStore(fake);
    await store.recordFailure({ machineId: 7, reason: "x" });
    await store.recordSuccess({ machineId: 7 });
    expect((await store.getBadIds()).has(7)).toBe(false);
    expect((await store.getGoodIds()).has(7)).toBe(true);
  });

  it("forget removes and returns true; false if it did not exist", async () => {
    const fake = makeFakeFs();
    const store = makeStore(fake);
    await store.recordFailure({ machineId: 9, reason: "x" });
    expect(await store.forget("bad", 9)).toBe(true);
    expect(await store.forget("bad", 9)).toBe(false);
    expect((await store.getBadIds()).size).toBe(0);
  });

  it("an empty file is treated as empty history", async () => {
    const store = makeStore(makeFakeFs("   "));
    expect(await store.read()).toEqual({ good: [], bad: [] });
  });

  it("a file with JSON lacking good/bad falls back to empty objects", async () => {
    const store = makeStore(makeFakeFs('{"other":1}'));
    expect(await store.read()).toEqual({ good: [], bad: [] });
  });

  it("a corrupted file throws an explicit error (it does not blindly overwrite)", async () => {
    const store = makeStore(makeFakeFs("{ not json"));
    await expect(store.read()).rejects.toThrow(/corrupted/);
  });

  it("propagates read errors that are NOT ENOENT (e.g. permissions)", async () => {
    const store = createHostHistoryStore({
      filePath: "/fake/x.json",
      readFileImpl: async () => {
        const err = new Error("EACCES");
        err.code = "EACCES";
        throw err;
      },
      writeFileImpl: async () => {},
      mkdirImpl: async () => {},
    });
    await expect(store.read()).rejects.toThrow("EACCES");
  });
});

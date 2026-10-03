/**
 * History of Vast hosts (physical machines) with MEMORY across sessions, so we
 * do not keep renting GPU machines that already failed.
 *
 * The scoring idea is adapted from a production GPU fleet supervisor that kept
 * this state in Redis. There is no Redis here: we persist to a local JSON file
 * with INJECTABLE IO (same pattern as `opencodeSync.mjs`), so the logic is
 * tested without touching disk and the server stays zero-dependency.
 *
 * Key design point: the ban is anchored to the `machineId` (STABLE physical
 * host), not to the offer `id` (ephemeral: Vast recycles it). Two lists:
 *  - good -> hosts that booted fine (real heartbeat/ready). They are PREFERRED.
 *  - bad  -> hosts that failed. They are EXCLUDED until the user removes them.
 * Redemption: a host that boots fine again leaves the blocklist on its own.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Normalizes a machineId to a finite positive number; null if invalid. */
export function normalizeMachineId(machineId) {
  const n = Number(machineId);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Empty history (canonical shape). */
function emptyHistory() {
  return { good: {}, bad: {} };
}

/**
 * Merges a boot SUCCESS into the history. PURE: returns a NEW object.
 * Increments the good host's counter and, if it was banned, redeems it
 * (removes it from bad).
 * @param {{ good: object, bad: object }} history
 * @param {{ machineId?: number, gpuName?: string, dphTotal?: number }} host
 * @param {number} [now]
 */
export function mergeSuccess(history, host, now = Date.now()) {
  const machineId = normalizeMachineId(host?.machineId);
  if (machineId === null) return history; // no stable identity -> no history kept
  const good = { ...(history?.good ?? {}) };
  const bad = { ...(history?.bad ?? {}) };
  const prev = good[machineId];
  good[machineId] = {
    machineId,
    gpuName: host.gpuName ?? prev?.gpuName,
    dphTotal: host.dphTotal ?? prev?.dphTotal,
    successCount: (prev?.successCount ?? 0) + 1,
    firstSuccessAt: prev?.firstSuccessAt ?? now,
    lastSuccessAt: now,
  };
  if (bad[machineId]) delete bad[machineId]; // redemption
  return { good, bad };
}

/**
 * Merges a FAILURE into the history. PURE: returns a NEW object. Adds or
 * updates the host in the blocklist (excluded until manually removed).
 * @param {{ good: object, bad: object }} history
 * @param {{ machineId?: number, gpuName?: string, reason: string }} host
 * @param {number} [now]
 */
export function mergeFailure(history, host, now = Date.now()) {
  const machineId = normalizeMachineId(host?.machineId);
  if (machineId === null) return history;
  const good = { ...(history?.good ?? {}) };
  const bad = { ...(history?.bad ?? {}) };
  const prev = bad[machineId];
  bad[machineId] = {
    machineId,
    gpuName: host.gpuName ?? prev?.gpuName,
    reason: host.reason ?? "unknown",
    failCount: (prev?.failCount ?? 0) + 1,
    firstFailAt: prev?.firstFailAt ?? now,
    lastFailAt: now,
  };
  return { good, bad };
}

/** Removes a machineId from a list ('good'|'bad'). PURE. Returns { history, removed }. */
export function mergeForget(history, list, machineId) {
  const id = normalizeMachineId(machineId);
  const bucket = { ...(history?.[list] ?? {}) };
  if (id === null || !bucket[id]) {
    return {
      history: {
        good: { ...(history?.good ?? {}) },
        bad: { ...(history?.bad ?? {}) },
      },
      removed: false,
    };
  }
  delete bucket[id];
  const next = {
    good: { ...(history?.good ?? {}) },
    bad: { ...(history?.bad ?? {}) },
  };
  next[list] = bucket;
  return { history: next, removed: true };
}

/** Sorts the raw history into presentable lists (good by successes, bad by recency). */
export function toSortedHistory(history) {
  const good = Object.values(history?.good ?? {})
    .filter((h) => normalizeMachineId(h?.machineId) !== null)
    .sort(
      (a, b) =>
        (b.successCount ?? 0) - (a.successCount ?? 0) ||
        (b.lastSuccessAt ?? 0) - (a.lastSuccessAt ?? 0),
    );
  const bad = Object.values(history?.bad ?? {})
    .filter((h) => normalizeMachineId(h?.machineId) !== null)
    .sort((a, b) => (b.lastFailAt ?? 0) - (a.lastFailAt ?? 0));
  return { good, bad };
}

/** Set of machineIds of a list ('good'|'bad') built from the raw history. */
export function idSetFrom(history, list) {
  const ids = new Set();
  for (const key of Object.keys(history?.[list] ?? {})) {
    const id = normalizeMachineId(key);
    if (id !== null) ids.add(id);
  }
  return ids;
}

/**
 * Creates the history store with JSON-file persistence. IO is injectable.
 * Each operation does a read-modify-write that is atomic enough for a
 * single-user PoC (no real concurrent writes).
 *
 * @param {{
 *   filePath: string,
 *   readFileImpl?: typeof readFile,
 *   writeFileImpl?: typeof writeFile,
 *   mkdirImpl?: typeof mkdir,
 * }} deps
 */
export function createHostHistoryStore(deps) {
  const { filePath } = deps;
  const readFileImpl = deps.readFileImpl ?? readFile;
  const writeFileImpl = deps.writeFileImpl ?? writeFile;
  const mkdirImpl = deps.mkdirImpl ?? mkdir;

  async function load() {
    let raw;
    try {
      raw = await readFileImpl(filePath, "utf-8");
    } catch (err) {
      if (err?.code === "ENOENT") return emptyHistory();
      throw err; // permissions or another real error: let the caller decide
    }
    if (!raw.trim()) return emptyHistory();
    try {
      const obj = JSON.parse(raw);
      return {
        good: obj && typeof obj.good === "object" && obj.good ? obj.good : {},
        bad: obj && typeof obj.bad === "object" && obj.bad ? obj.bad : {},
      };
    } catch {
      // Corrupted file: we do NOT blindly overwrite it (it may have been hand-edited).
      throw new Error(`The host history file is corrupted: ${filePath}`);
    }
  }

  async function save(history) {
    await mkdirImpl(dirname(filePath), { recursive: true });
    await writeFileImpl(
      filePath,
      `${JSON.stringify(history, null, 2)}\n`,
      "utf-8",
    );
  }

  return {
    /** Persists a successful boot of the host (redeems it if it was banned). */
    async recordSuccess(host) {
      const next = mergeSuccess(await load(), host);
      await save(next);
    },
    /** Persists a host failure (adds it to the blocklist). */
    async recordFailure(host) {
      const next = mergeFailure(await load(), host);
      await save(next);
    },
    /** Returns the sorted, presentable history: { good[], bad[] }. */
    async read() {
      return toSortedHistory(await load());
    },
    /** Set of banned machineIds (to exclude in the offer ranking). */
    async getBadIds() {
      return idSetFrom(await load(), "bad");
    },
    /** Set of known-good machineIds (to prioritize in the ranking). */
    async getGoodIds() {
      return idSetFrom(await load(), "good");
    },
    /** Removes a host from a list ('good'|'bad'). True if it existed. */
    async forget(list, machineId) {
      const { history, removed } = mergeForget(await load(), list, machineId);
      if (removed) await save(history);
      return removed;
    },
  };
}

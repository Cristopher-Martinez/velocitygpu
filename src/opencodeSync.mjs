/**
 * Syncs the user's `opencode.json` with the endpoint/model of the freshly
 * rented GPU. It removes the pain of hand-editing the config every time the
 * IP:port changes (Vast assigns a different one per instance).
 *
 * Design: a PURE function (`mergeOpencodeProvider`) that merges the provider
 * without destroying the rest of the config, + an IO layer
 * (`syncOpencodeConfig`) with injectable read/write so the logic can be tested
 * without touching disk.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveModelLimits } from "./models.mjs";

/** Provider ID in opencode. MUST match the one in the user's /connect. */
export const PROVIDER_ID = "velocity-gpu";
const PROVIDER_NPM = "@ai-sdk/openai-compatible";
const PROVIDER_NAME = "Velocity GPU (Vast)";
const DEFAULT_API_KEY = "no-key-needed";
const OPENCODE_SCHEMA = "https://opencode.ai/config.json";

/**
 * Parses JSON or JSONC (JSON with line and block comments). It respects
 * strings so it does NOT break URLs like `http://...` or escape sequences. It
 * also strips trailing commas before a closing `}` or `]`.
 *
 * Why it exists: opencode prefers `opencode.jsonc` over `opencode.json`, and a
 * `.jsonc` may contain comments. A bare `JSON.parse` would choke on them and
 * abort the sync.
 *
 * @param {string} raw raw file content
 * @returns {any} parsed object
 */
export function parseJsonc(raw) {
  let out = "";
  let inStr = false;
  let esc = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const n = raw[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlock = true;
      i++;
      continue;
    }
    // Trailing commas: legal in JSONC but NOT in JSON.parse. When closing an
    // object/array, we drop a trailing comma already buffered. This is safe
    // with respect to strings: the tail of `out` after closing a "…" is the
    // quote, never the comma inside the value.
    if (c === "}" || c === "]") {
      out = out.replace(/,\s*$/, "");
    }
    out += c;
  }
  return JSON.parse(out);
}

/**
 * Resolves which config file to write to. opencode supports `opencode.json`
 * and `opencode.jsonc`, and when BOTH exist it prefers the `.jsonc`. If we
 * wrote to the `.json` while opencode reads the `.jsonc`, the changes would
 * have no effect (a real bug: the IP/model stayed frozen).
 *
 * Rules:
 *  - If `opencode.jsonc` exists -> that one (it is the one opencode uses).
 *  - Otherwise -> `opencode.json` (created if needed).
 *
 * @param {string} dir config directory (e.g. `~/.config/opencode`)
 * @param {{ existsImpl?: typeof existsSync }} [opts]
 * @returns {string} absolute path of the file to write
 */
export function resolveOpencodeConfigPath(dir, { existsImpl = existsSync } = {}) {
  const jsonc = join(dir, "opencode.jsonc");
  if (existsImpl(jsonc)) return jsonc;
  return join(dir, "opencode.json");
}

/**
 * Normalizes a base endpoint to its OpenAI form (ending in /v1), without duplicating it.
 * @param {string} endpoint e.g. "http://1.2.3.4:31739" or "...:31739/v1"
 */
function toBaseUrl(endpoint) {
  const clean = endpoint.replace(/\/+$/, "");
  return clean.endsWith("/v1") ? clean : `${clean}/v1`;
}

/**
 * Merges the `velocity-gpu` provider into an opencode config object.
 * PURE: it does not touch disk, it returns a NEW object preserving everything
 * else (other providers, agents, etc.). It updates the baseURL and adds the
 * model if it was not there.
 *
 * @param {Record<string, any> | null | undefined} config Current config (or empty).
 * @param {{ endpoint: string, modelId: string, modelLabel?: string, contextLen?: number }} params
 * @returns {{ config: object, providerCreated: boolean, modelAdded: boolean, baseURL: string }}
 */
export function mergeOpencodeProvider(config, { endpoint, modelId, modelLabel, contextLen }) {
  if (!endpoint || !modelId) {
    throw new Error("endpoint and modelId are required to sync opencode.");
  }
  // Per-model dynamic limit: each model declares its native window in the
  // catalog (contextLen). That way opencode does not ask for more tokens than
  // the server actually serves, but we do not cap a model that supports a
  // larger context either.
  const limit = resolveModelLimits({ contextLen });
  const baseURL = toBaseUrl(endpoint);
  const next = { ...(config ?? {}) };
  if (!next.$schema) next.$schema = OPENCODE_SCHEMA;

  const providers = { ...(next.provider ?? {}) };
  const existing = providers[PROVIDER_ID] ?? {};
  const providerCreated = providers[PROVIDER_ID] === undefined;
  const prevModels = existing.models ?? {};
  const modelAdded = prevModels[modelId] === undefined;

  providers[PROVIDER_ID] = {
    ...existing,
    npm: existing.npm ?? PROVIDER_NPM,
    name: existing.name ?? PROVIDER_NAME,
    options: {
      ...(existing.options ?? {}),
      baseURL,
      apiKey: existing.options?.apiKey ?? DEFAULT_API_KEY,
    },
    models: {
      ...prevModels,
      [modelId]: prevModels[modelId] ?? {
        name: modelLabel ?? modelId,
        // We bound context/output to what the server serves for THIS model.
        // Otherwise opencode asks for max_tokens=32000 and the request blows up
        // against the server's context length. We preserve any limit the user
        // has already set (left branch of the ??).
        limit,
      },
    },
  };
  next.provider = providers;
  return { config: next, providerCreated, modelAdded, baseURL };
}

/**
 * Reads opencode.json (if it exists), merges the provider and rewrites it.
 * Creates the directory/file if missing. It does NOT blindly overwrite a
 * corrupted file.
 *
 * @param {{
 *   configPath: string,
 *   endpoint: string,
 *   modelId: string,
 *   modelLabel?: string,
 *   contextLen?: number,
 *   readFileImpl?: typeof readFile,
 *   writeFileImpl?: typeof writeFile,
 *   mkdirImpl?: typeof mkdir,
 * }} params
 * @returns {Promise<{ path: string, created: boolean, providerCreated: boolean, modelAdded: boolean, baseURL: string }>}
 */
export async function syncOpencodeConfig(params) {
  const { configPath, endpoint, modelId, modelLabel, contextLen } = params;
  const rf = params.readFileImpl ?? readFile;
  const wf = params.writeFileImpl ?? writeFile;
  const md = params.mkdirImpl ?? mkdir;
  if (!configPath) throw new Error("opencode configPath is not configured.");

  let current = {};
  let existed = false;
  try {
    const raw = await rf(configPath, "utf-8");
    existed = true;
    current = raw.trim() ? parseJsonc(raw) : {};
  } catch (err) {
    // ENOENT = it does not exist yet -> we create it. Any other error (corrupt
    // JSON, permissions) is NOT blindly overwritten: we abort to avoid losing data.
    if (err?.code !== "ENOENT") {
      throw new Error(`Could not read the opencode config (${configPath}): ${err.message}`);
    }
  }

  const { config, providerCreated, modelAdded, baseURL } = mergeOpencodeProvider(current, {
    endpoint,
    modelId,
    modelLabel,
    contextLen,
  });

  await md(dirname(configPath), { recursive: true });
  await wf(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

  return { path: configPath, created: !existed, providerCreated, modelAdded, baseURL };
}

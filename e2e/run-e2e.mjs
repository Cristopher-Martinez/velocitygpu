/**
 * REAL end-to-end driver for Velocity GPU: it exercises the full flow against
 * Vast.ai.
 *
 *   1. Checks the Vast account balance.
 *   2. Searches for a single-GPU machine for the chosen model (real provisioner).
 *   3. RENTS it, starting an empty Ollama (real createInstance).
 *   4. Pulls the GGUF, warms the model up and polls until it is resident in
 *      VRAM (same probe/pull/warmup modules the server uses).
 *   5. ASKS the model something through the OpenAI endpoint and validates the answer.
 *   6. DESTROYS the instance (guaranteed: try/finally + signal handlers).
 *
 * WARNING: THIS COSTS MONEY. It rents a real GPU that bills by the hour. The
 *     safety net destroys the instance on ANY exit (success, error, Ctrl+C,
 *     uncaught exception). Still, confirm the destruction in the Vast console.
 *
 * It reuses the product's REAL modules so it validates the same code the PoC
 * serves at runtime, not a replica.
 *
 * Usage:
 *   $env:VAST_API_KEY="..."; node e2e/run-e2e.mjs
 *   $env:E2E_MODEL="qwen2_5-32b"; node e2e/run-e2e.mjs   # heavier model
 *
 * Flags/env:
 *   E2E_MODEL        catalog id (default qwen2_5-7b, the cheapest that validates the flow)
 *   E2E_MAX_DPH      offer price cap in $/h (default 2.0), rejects overpriced machines
 *   E2E_READY_MS     model-load timeout (default 1200000 = 20 min)
 *   --keep           do NOT destroy at the end (to inspect it manually)
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { createVastApiClient } from "../src/vastClient.mjs";
import { findModel } from "../src/models.mjs";
import {
  buildOfferQuery,
  pickBestOffer,
  buildInstanceBody,
} from "../src/provisioner.mjs";
import { probeOllama, deriveOllamaPhase } from "../src/rentalStore.mjs";
import { pullModelStreaming, warmupModel } from "../src/ollamaClient.mjs";

// ── Colored console ─────────────────────────────────────────────────────────
const C = {
  ok: (s) => `\x1b[32m✓\x1b[0m ${s}`,
  fail: (s) => `\x1b[31m✗\x1b[0m ${s}`,
  info: (s) => `\x1b[36m▸\x1b[0m ${s}`,
  warn: (s) => `\x1b[33m⚠\x1b[0m ${s}`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};
const log = (s) => console.log(s);

// ── Config (env + flags) ────────────────────────────────────────────────────
const KEEP = process.argv.includes("--keep");
const MODEL_ID = process.env.E2E_MODEL ?? "qwen2_5-7b";
const MAX_DPH = Number(process.env.E2E_MAX_DPH ?? 2.0);
const READY_MS = Number(process.env.E2E_READY_MS ?? 20 * 60 * 1000);
const POLL_EVERY_MS = 10_000;

/** Loads VAST_API_KEY from the env or from the project's .env (dependency-free). */
function loadApiKey() {
  if (process.env.VAST_API_KEY) return process.env.VAST_API_KEY;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", ".env"), "utf-8");
    const match = raw.match(/^VAST_API_KEY=(.*)$/m);
    if (match) return match[1].trim();
  } catch {
    /* no .env: fall through to the error below */
  }
  return "";
}

/** Non-streaming question to Ollama's OpenAI endpoint; returns the text. */
async function askModel(endpoint, modelTag, question) {
  const res = await fetch(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelTag,
      messages: [{ role: "user", content: question }],
      stream: false,
      temperature: 0.2,
      max_tokens: 128,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Ollama ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

async function main() {
  const apiKey = loadApiKey();
  if (!apiKey) {
    log(C.fail("VAST_API_KEY is not configured (env or .env)."));
    process.exit(2);
  }
  const model = findModel(MODEL_ID);
  if (!model) {
    log(C.fail(`Unknown model: ${MODEL_ID}`));
    process.exit(2);
  }

  const vast = createVastApiClient({ apiKey });
  /** @type {number | undefined} instance to ALWAYS clean up. */
  let instanceId;

  // Safety net: destroy on signals (Ctrl+C / kill) before exiting.
  const onSignal = async (sig) => {
    log(C.warn(`\nSignal ${sig} — destroying the instance before exiting...`));
    await safeDestroy(vast, instanceId);
    process.exit(130);
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  try {
    log(C.info(`Model: ${model.label} (${model.params}B, gpus=${model.tensorParallel})`));

    // 1) Balance
    const acct = await vast.getAccount();
    log(C.ok(`Vast account OK — balance $${(acct.balance ?? 0).toFixed(2)}`));

    // 2) Find an offer
    log(C.info("Looking for a GPU machine..."));
    const offers = await vast.searchOffers(buildOfferQuery(model));
    const offer = pickBestOffer(model, offers);
    if (!offer) throw new Error("No offers meet the required VRAM.");
    if (offer.dphTotal > MAX_DPH) {
      throw new Error(
        `Cheapest offer $${offer.dphTotal.toFixed(3)}/h > cap E2E_MAX_DPH=$${MAX_DPH}. Aborting to avoid overspending.`,
      );
    }
    log(
      C.ok(
        `Offer: ${offer.numGpus}× ${offer.gpuName} · ${offer.totalVramGb}GB · $${offer.dphTotal.toFixed(3)}/h`,
      ),
    );

    // 3) Rent (starts an empty Ollama)
    log(C.info("Renting and starting Ollama..."));
    const created = await vast.createInstance(offer.id, buildInstanceBody(model));
    instanceId = created.newInstanceId;
    if (!instanceId) throw new Error("Vast did not return an instanceId.");
    log(C.ok(`Instance created: ${instanceId}`));

    // 4) Pull + warm up + poll until ready
    log(
      C.info(
        `Waiting for the model to load (timeout ${Math.round(READY_MS / 60000)} min)...`,
      ),
    );
    const endpoint = await waitUntilReady(vast, instanceId, model, READY_MS);
    log(C.ok(`Model loaded and serving at ${endpoint}`));

    // 5) Ask the model
    const question = "In one short sentence, what is a GPU?";
    log(C.info(`Question: "${question}"`));
    const answer = await askModel(endpoint, model.ollamaTag, question);
    if (!answer || !answer.trim())
      throw new Error("The model returned an empty answer.");
    log(C.ok("Model answer:"));
    log(C.dim(`   ${answer.trim().replace(/\n/g, "\n   ")}`));

    log("");
    log(
      C.ok("E2E PASSED — rental, model load, inference and answer verified."),
    );
  } finally {
    if (KEEP) {
      log(
        C.warn(
          `--keep is on: instance ${instanceId} IS STILL RUNNING (billing). Destroy it manually.`,
        ),
      );
    } else {
      await safeDestroy(vast, instanceId);
    }
  }
}

/**
 * Polls the instance until the model is resident in VRAM; returns the endpoint.
 * Mirrors the server's /api/status loop: the pull and the warmup are each
 * fired once in the background, and the read-only probe observes the result.
 */
async function waitUntilReady(vast, instanceId, model, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastPhase = "";
  const running = { pulling: false, warming: false };
  const background = (flag, task, label) => {
    running[flag] = true;
    task()
      .catch((err) =>
        console.log(C.dim(`   ${label} failed: ${String(err?.message ?? err)}`)),
      )
      .finally(() => {
        running[flag] = false;
      });
  };
  while (Date.now() < deadline) {
    const inst = await vast.getInstance(instanceId).catch(() => null);
    const endpoint =
      inst?.publicIp && inst?.apiPort
        ? `http://${inst.publicIp}:${inst.apiPort}`
        : undefined;
    const probe = endpoint ? await probeOllama(endpoint, model.ollamaTag) : "down";
    if (probe === "no-model" && !running.pulling) {
      background(
        "pulling",
        () =>
          pullModelStreaming(endpoint, model.ollamaTag, undefined, ({ status, percent }) =>
            console.log(C.dim(`   pull: ${status}${percent != null ? ` ${percent}%` : ""}`)),
          ),
        "pull",
      );
    }
    if (probe === "loading" && !running.warming) {
      background("warming", () => warmupModel(endpoint, model.ollamaTag), "warmup");
    }
    const derived = deriveOllamaPhase(inst, probe);
    if (derived.phase !== lastPhase) {
      lastPhase = derived.phase;
      console.log(C.dim(`   [${derived.phase}] ${derived.message ?? ""}`));
    }
    if (derived.phase === "ready" && derived.endpoint) return derived.endpoint;
    await sleep(POLL_EVERY_MS);
  }
  throw new Error(
    `Timeout: the model was not ready within ${Math.round(timeoutMs / 60000)} min.`,
  );
}

/** Destroys the instance best-effort; never throws (it is the safety net). */
async function safeDestroy(vast, instanceId) {
  if (!instanceId) return;
  try {
    await vast.destroyInstance(instanceId);
    console.log(C.ok(`Instance ${instanceId} destroyed.`));
  } catch (err) {
    console.log(
      C.fail(
        `Could not destroy ${instanceId}: ${String(err?.message ?? err)} — DESTROY IT MANUALLY in the Vast console.`,
      ),
    );
  }
}

main().catch(async (err) => {
  console.log(C.fail(`E2E FAILED: ${String(err?.message ?? err)}`));
  process.exit(1);
});

/**
 * Velocity GPU — server bootstrap. Creates the real dependencies (Vast client,
 * rental store) and starts the HTTP server. ALL the logic lives in
 * `src/app.mjs` (testable with injected dependencies, without opening ports).
 *
 * Security: VAST_API_KEY lives only here (env). It never travels to the frontend.
 */

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { createVastApiClient } from "./src/vastClient.mjs";
import { createRentalStore } from "./src/rentalStore.mjs";
import { createHostHistoryStore } from "./src/hostHistory.mjs";
import { createApp } from "./src/app.mjs";
import { resolveRuntimeMode, isDesktopMode } from "./src/runtime.mjs";
import { reconcileOrphan } from "./src/reconciler.mjs";
import { resolveOpencodeConfigPath } from "./src/opencodeSync.mjs";

export function startServer({ port, apiKey } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const resolvedPort = port ?? Number(process.env.PORT ?? 5174);
  const resolvedKey = apiKey ?? process.env.VAST_API_KEY ?? "";

  const vast = createVastApiClient({ apiKey: resolvedKey });
  const rental = createRentalStore();
  // Runtime mode: `desktop` (Electron, on the user's machine) enables opencode
  // auto-config; `web` (hosted) shows the manual step-by-step.
  const mode = resolveRuntimeMode(process.env);
  // Path to the user's opencode config (for "Apply to opencode"). opencode
  // supports both opencode.json AND opencode.jsonc, and prefers the .jsonc when
  // both exist. The resolver picks the file opencode actually reads so the sync
  // does not get stuck. Override with OPENCODE_CONFIG.
  const opencodeConfigPath =
    process.env.OPENCODE_CONFIG ??
    resolveOpencodeConfigPath(join(homedir(), ".config", "opencode"));
  // Host history with memory across sessions (GPU blocklist/allowlist).
  // Override with VELOCITY_HOST_HISTORY; defaults to ~/.config/velocitygpu/.
  const hostHistoryPath =
    process.env.VELOCITY_HOST_HISTORY ??
    join(homedir(), ".config", "velocitygpu", "host-history.json");
  const hostHistory = createHostHistoryStore({ filePath: hostHistoryPath });
  const handler = createApp({
    vast,
    rental,
    apiKey: resolvedKey,
    publicDir: join(here, "public"),
    opencodeConfigPath,
    mode,
    hostHistory,
  });

  const server = createServer(handler);
  // On desktop the server is single-user and local, so we bind to loopback only
  // to avoid exposing an unauthenticated endpoint to the network. On web we
  // listen on all interfaces.
  const host = isDesktopMode(mode) ? "127.0.0.1" : undefined;
  server.listen(resolvedPort, host, () => {
    // With an ephemeral port (0, desktop mode) the OS assigns the real one: we read it.
    const addr = server.address();
    const livePort =
      typeof addr === "object" && addr ? addr.port : resolvedPort;
    console.log(`Velocity GPU [${mode}] → http://localhost:${livePort}`);
    if (!resolvedKey)
      console.warn(
        "VAST_API_KEY is not configured — set it before renting.",
      );
    // Orphan re-adoption: if a restart lost track of an instance that is still
    // alive and billing, we recover it so the panel/timer/chat reflect reality
    // again. Best-effort: never takes down the startup.
    if (resolvedKey) {
      reconcileOrphan({ vast, rental }).catch((err) =>
        console.warn(
          `[reconcile] failed on boot: ${String(err?.message ?? err)}`,
        ),
      );
    }
  });
  return server;
}

// Only starts when run directly (not when imported in tests).
/* c8 ignore next 3 -- entrypoint guard: unreachable under the test runner */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}

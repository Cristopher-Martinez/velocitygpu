/**
 * Runtime mode of the product. Velocity GPU is MIXED: the SAME server serves
 * the UI both hosted on the web and wrapped in Electron (desktop app).
 *
 * The key difference is the CAPABILITY to auto-configure opencode: writing
 * `~/.config/opencode/opencode.json` only makes sense if the server runs on the
 * user's machine (desktop). Hosted on the web it would write the wrong
 * server's disk, so in that case we show the manual step-by-step instead.
 *
 * The AUTHORITY is the server (it is the one that writes the file), not the
 * browser: the frontend asks `/api/environment` and adapts the UI. Electron
 * starts the server with `VELOCITY_MODE=desktop`; any other startup falls back
 * to `web` (safe by default: we never auto-write on a remote host).
 */

export const RUNTIME_MODES = Object.freeze({ DESKTOP: "desktop", WEB: "web" });

/**
 * Resolves the mode from the environment. `VELOCITY_MODE=desktop` -> desktop;
 * any other value (or none) -> web.
 * @param {Record<string, string | undefined>} [env]
 * @returns {"desktop" | "web"}
 */
export function resolveRuntimeMode(env = process.env) {
  const raw = String(env?.VELOCITY_MODE ?? "")
    .trim()
    .toLowerCase();
  return raw === RUNTIME_MODES.DESKTOP
    ? RUNTIME_MODES.DESKTOP
    : RUNTIME_MODES.WEB;
}

/**
 * Can this mode auto-configure opencode by writing to the local disk?
 * @param {string} mode
 */
export function isDesktopMode(mode) {
  return mode === RUNTIME_MODES.DESKTOP;
}

/**
 * Describes the environment for the frontend: the mode and whether it can
 * auto-configure.
 * @param {string} mode
 * @returns {{ mode: "desktop" | "web", canAutoConfig: boolean }}
 */
export function describeEnvironment(mode) {
  const desktop = isDesktopMode(mode);
  return {
    mode: desktop ? RUNTIME_MODES.DESKTOP : RUNTIME_MODES.WEB,
    canAutoConfig: desktop,
  };
}

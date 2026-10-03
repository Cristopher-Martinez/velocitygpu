/**
 * Electron main — wraps Velocity GPU as a DESKTOP app.
 *
 * Key difference vs. the web version: it starts the SAME server but with
 * `VELOCITY_MODE=desktop`, which enables opencode auto-config (writing the
 * local `opencode.json`). The server listens on loopback only and the window
 * loads it. No remote auto-config, no ports exposed to the network.
 *
 * Window security: contextIsolation ON, nodeIntegration OFF, with a minimal
 * preload. The frontend is still the same HTML/JS served by the server.
 */

const { app, BrowserWindow, shell } = require("electron");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { readFileSync } = require("node:fs");

// Desktop mode BEFORE importing the server (it reads it in startServer()).
process.env.VELOCITY_MODE = "desktop";

/**
 * Loads KEY=VALUE pairs from a .env file into process.env (without overriding
 * what is already set). Minimal and dependency-free: the desktop app needs
 * VAST_API_KEY.
 */
function loadEnvFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return; // does not exist: carry on with whatever is in the environment
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

let serverRef = null;

async function createWindow() {
  // The project's own .env, if present.
  loadEnvFile(join(__dirname, "..", ".env"));

  // Dynamic import: server.mjs is ESM, this main is CJS. On Windows the
  // absolute path must be passed as a file:// URL (the ESM loader rejects the
  // `c:` scheme).
  const serverUrl = pathToFileURL(join(__dirname, "..", "server.mjs")).href;
  const { startServer } = await import(serverUrl);
  // Ephemeral port (0): the OS picks a free one -> no clash with the local web version.
  serverRef = startServer({ port: 0 });
  await new Promise((resolve) => serverRef.once("listening", resolve));
  const addr = serverRef.address();
  const port = typeof addr === "object" && addr ? addr.port : 5174;

  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    backgroundColor: "#0b0f17",
    title: "Velocity GPU",
    // Do not show until the content is painted: avoids the white flash and the
    // "ghost" window that opens behind other apps.
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Once the frontend is ready, show the window and bring it to the front.
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });

  // External links -> the system browser, not stray Electron windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.loadURL(`http://127.0.0.1:${port}`);
}

app.whenReady().then(createWindow);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  if (serverRef) serverRef.close();
  if (process.platform !== "darwin") app.quit();
});

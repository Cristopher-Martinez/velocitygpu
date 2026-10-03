/**
 * Minimal preload. The UI already detects the mode through `GET /api/environment`
 * (the server is the authority), so here we only expose an informational flag in
 * case the frontend wants to show something "native". No Node, no risky IPC.
 */

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("velocityDesktop", {
  isDesktop: true,
  platform: process.platform,
});

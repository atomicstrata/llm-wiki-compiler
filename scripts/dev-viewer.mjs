#!/usr/bin/env node
/**
 * Development runner for the local viewer.
 *
 * The packaged `llmwiki view` process freezes a wiki snapshot and caches the
 * HTML shell template for predictable runtime behavior. During viewer UI work
 * that cache is inconvenient: changes under `src/viewer/assets/` need a rebuild
 * and a fresh server process before the browser can see them. This runner uses
 * the normal build pipeline, watches source/static files, and restarts
 * `node dist/cli.js view` after each successful rebuild.
 */

import chokidar from "chokidar";
import { spawn } from "node:child_process";
import process from "node:process";

const DEFAULT_PORT = "55374";
const DEBOUNCE_MS = 150;
const WATCH_TARGETS = [
  "src/viewer",
  "src/commands/view.ts",
  "src/cli.ts",
  "scripts/copy-viewer-assets.mjs",
  "tsup.config.ts",
  "package.json",
];
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const viewerArgs = normalizeViewerArgs(process.argv.slice(2));

let viewer = null;
let buildRunning = false;
let rebuildQueued = false;
let debounceTimer = null;
let shuttingDown = false;

await rebuildAndRestart("initial");
startWatcher();
registerShutdownHandlers();

/** Add a stable dev port unless the caller supplied one explicitly. */
function normalizeViewerArgs(args) {
  if (args.includes("--port")) return args;
  if (args.some((arg) => arg.startsWith("--port="))) return args;
  return ["--port", DEFAULT_PORT, ...args];
}

/** Start the filesystem watcher after the initial build succeeds. */
function startWatcher() {
  const watcher = chokidar.watch(WATCH_TARGETS, {
    ignoreInitial: true,
    ignored: ["dist/**", "node_modules/**", ".git/**"],
  });
  watcher.on("all", (_event, changedPath) => queueRebuild(changedPath));
  watcher.on("error", (err) => {
    process.stderr.write(`[dev] watcher error: ${err.message}\n`);
  });
}

/** Debounce rapid editor writes into one rebuild. */
function queueRebuild(reason) {
  if (shuttingDown) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void rebuildAndRestart(reason);
  }, DEBOUNCE_MS);
}

/** Run `npm run build`, then restart the viewer when it succeeds. */
async function rebuildAndRestart(reason) {
  if (buildRunning) {
    rebuildQueued = true;
    return;
  }
  buildRunning = true;
  process.stdout.write(`\n[dev] rebuilding after ${reason}\n`);
  const ok = await runBuild();
  buildRunning = false;
  if (ok) restartViewer();
  await drainQueuedRebuild();
}

/** Re-run a rebuild that was queued while a previous one was in flight. */
async function drainQueuedRebuild() {
  if (!rebuildQueued || shuttingDown) return;
  rebuildQueued = false;
  await rebuildAndRestart("queued changes");
}

/** Execute the standard project build so dist/ and viewer assets stay in sync. */
function runBuild() {
  return new Promise((resolve) => {
    const child = spawn(npmCommand, ["run", "build"], { stdio: "inherit" });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", (err) => {
      process.stderr.write(`[dev] build failed to start: ${err.message}\n`);
      resolve(false);
    });
  });
}

/** Stop the old viewer process and start a fresh one against the rebuilt dist. */
function restartViewer() {
  stopViewer();
  viewer = spawn(process.execPath, ["dist/cli.js", "view", ...viewerArgs], {
    stdio: "inherit",
  });
  viewer.on("exit", reportViewerExit);
}

/** Log unexpected viewer exits; stay quiet on shutdown, clean exits, and SIGTERM. */
function reportViewerExit(code, signal) {
  if (shouldSuppressViewerExit(code, signal)) return;
  process.stderr.write(`[dev] viewer exited with ${signal ?? code}\n`);
}

/** True when a viewer exit is expected and should not produce stderr noise. */
function shouldSuppressViewerExit(code, signal) {
  if (shuttingDown) return true;
  if (code === 0) return true;
  if (signal === "SIGTERM") return true;
  return false;
}

/** Terminate the active viewer process, if any. */
function stopViewer() {
  if (!viewer || viewer.killed) return;
  viewer.kill("SIGTERM");
  viewer = null;
}

/** Ensure Ctrl-C or SIGTERM leaves no child viewer process behind. */
function registerShutdownHandlers() {
  const shutdown = () => {
    shuttingDown = true;
    stopViewer();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

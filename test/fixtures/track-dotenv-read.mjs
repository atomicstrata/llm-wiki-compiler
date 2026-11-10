/**
 * Records project `.env` reads made by a real CLI subprocess.
 *
 * Loaded through Bun's `--preload` (via BUN_OPTIONS) before the built CLI. It
 * wraps only the synchronous file API used by dotenv and leaves all file
 * contents untouched.
 *
 * Bun can also load `.env` itself, natively and before any preload, which no
 * file-API wrapper can observe. A project `.env` that sets
 * LLMWIKI_TEST_DOTENV_SENTINEL is therefore recorded here when the variable is
 * already present at preload time: only the runtime could have put it there.
 */

import fs from "node:fs";
import path from "node:path";

const originalReadFileSync = fs.readFileSync;
const logPath = process.env.LLMWIKI_TEST_DOTENV_READ_LOG;
const configuredTarget = process.env.LLMWIKI_TEST_DOTENV_TARGET;

/** Resolve the fs API's supported path inputs to one comparable path. */
function resolveInput(file) {
  return path.resolve(file instanceof URL ? file.pathname : String(file));
}

/** Limit tracking to dotenv's default or the test's explicit configured path. */
function shouldTrack(filePath) {
  if (path.basename(filePath) === ".env") return true;
  return configuredTarget ? filePath === path.resolve(configuredTarget) : false;
}

if (logPath && process.env.LLMWIKI_TEST_DOTENV_SENTINEL) {
  fs.appendFileSync(logPath, "runtime-loaded .env before llmwiki started\n");
}

fs.readFileSync = function trackedReadFileSync(file, ...args) {
  const filePath = resolveInput(file);
  if (logPath && shouldTrack(filePath)) fs.appendFileSync(logPath, `${filePath}\n`);
  return originalReadFileSync.call(this, file, ...args);
};

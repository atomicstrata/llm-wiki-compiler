/**
 * Records project `.env` reads made by a real CLI subprocess.
 *
 * Loaded through Node's `--import` hook before the built CLI. It wraps only the
 * synchronous file API used by dotenv and leaves all file contents untouched.
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

fs.readFileSync = function trackedReadFileSync(file, ...args) {
  const filePath = resolveInput(file);
  if (logPath && shouldTrack(filePath)) fs.appendFileSync(logPath, `${filePath}\n`);
  return originalReadFileSync.call(this, file, ...args);
};

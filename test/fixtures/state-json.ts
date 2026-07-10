/**
 * Shared helpers for writing `.llmwiki/state.json` in tests.
 *
 * Freshness and state tests need compact state fixtures without going through
 * the production atomic writer. These helpers keep that setup consistent and
 * avoid duplicated mkdir/writeFile boilerplate across test files.
 */

import { mkdir, writeFile, readFile } from "fs/promises";
import { createHash } from "node:crypto";
import path from "path";
import { LLMWIKI_DIR, STATE_FILE } from "../../src/utils/constants.js";
import type { WikiState } from "../../src/utils/types.js";

/** Read and parse the persisted `.llmwiki/state.json` for a test root. */
export async function readPersistedState(root: string): Promise<WikiState> {
  return JSON.parse(await readFile(path.join(root, STATE_FILE), "utf-8"));
}

/** Hex SHA-256 of a string — mirrors the compiler's source hashing for fixtures. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Write a state file from a `filename -> { hash, concepts }` map, filling in a
 * fixed `compiledAt`. The common freshness-test setup, shared so the wrapper
 * isn't re-declared per file.
 */
export async function writeSourceState(
  root: string,
  sources: Record<string, { hash: string; concepts: string[] }>,
): Promise<void> {
  const entries = Object.fromEntries(
    Object.entries(sources).map(([file, s]) => [file, { ...s, compiledAt: "t" }]),
  );
  await writeTestStateJson(root, { version: 1, indexHash: "", sources: entries });
}

/** Write a source file under `sources/`, creating the directory if needed. */
export async function writeSourceFile(root: string, file: string, content: string): Promise<void> {
  await mkdir(path.join(root, "sources"), { recursive: true });
  await writeFile(path.join(root, "sources", file), content);
}

/** Write a raw JSON string to the test project's state file. */
export async function writeRawTestStateJson(root: string, contents: string): Promise<void> {
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  await writeFile(path.join(root, STATE_FILE), contents, "utf-8");
}

/** Write a parsed WikiState object to the test project's state file. */
export async function writeTestStateJson(root: string, state: WikiState): Promise<void> {
  await writeRawTestStateJson(root, JSON.stringify(state));
}

/** Write intentionally invalid state JSON for corrupt-state regression tests. */
export async function writeCorruptTestStateJson(root: string): Promise<void> {
  await writeRawTestStateJson(root, "{ not valid json");
}

/**
 * Canonical valid version:1 state fixture shared by state-read tests so the
 * "reports ok and carries the parsed source" assertion isn't re-declared per
 * file. One tracked source with a known hash.
 */
export const SAMPLE_OK_STATE_V1: WikiState = {
  version: 1,
  indexHash: "",
  sources: { "a.md": { hash: "h", concepts: ["x"], compiledAt: "t" } },
};

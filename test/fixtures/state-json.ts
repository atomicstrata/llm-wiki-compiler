/**
 * Shared helpers for writing `.llmwiki/state.json` in tests.
 *
 * Freshness and state tests need compact state fixtures without going through
 * the production atomic writer. These helpers keep that setup consistent and
 * avoid duplicated mkdir/writeFile boilerplate across test files.
 */

import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { LLMWIKI_DIR, STATE_FILE } from "../../src/utils/constants.js";
import type { WikiState } from "../../src/utils/types.js";

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

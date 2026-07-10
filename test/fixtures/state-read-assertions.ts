/**
 * Shared assertion helpers for `readStateClassified` outcomes.
 *
 * The version-guard and classified-state suites both assert the canonical
 * "ok" and "corrupt" read outcomes (status + carried state + no `.bak` side
 * effect). Centralizing those assertions keeps the suites DRY and gives both
 * a single place to update if the contract changes.
 */

import { expect } from "vitest";
import { existsSync } from "fs";
import path from "path";
import { readStateClassified } from "../../src/utils/state.js";
import { STATE_FILE } from "../../src/utils/constants.js";
import { SAMPLE_OK_STATE_V1, writeCorruptTestStateJson, writeTestStateJson } from "./state-json.js";

const bakPath = (root: string) => path.join(root, STATE_FILE + ".bak");

/** Write {@link SAMPLE_OK_STATE_V1} then assert it reads back as a parsed "ok" state. */
export async function expectReadsOkV1(root: string): Promise<void> {
  await writeTestStateJson(root, SAMPLE_OK_STATE_V1);
  const result = await readStateClassified(root);
  expect(result.status).toBe("ok");
  expect(result.state.sources["a.md"].hash).toBe("h");
}

/** Write unparseable JSON then assert "corrupt" with an empty state and NO `.bak`. */
export async function expectReadsCorruptNoBak(root: string): Promise<void> {
  await writeCorruptTestStateJson(root);
  const result = await readStateClassified(root);
  expect(result.status).toBe("corrupt");
  expect(result.state.sources).toEqual({});
  expect(existsSync(bakPath(root))).toBe(false);
}

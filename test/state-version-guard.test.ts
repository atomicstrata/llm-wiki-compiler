/**
 * Regression tests for the fail-closed newer-than-known state-version guard.
 *
 * A `state.json` written by a future llmwiki (version > KNOWN_STATE_VERSION)
 * must NOT be silently treated as healthy/empty. `readStateClassified` reports
 * `status: "too-new"` (carrying the parsed state, writing nothing); `readState`
 * throws a typed `StateTooNewError`. v1/v2/missing/corrupt behavior is unchanged.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";
import {
  readStateClassified,
  readState,
  StateTooNewError,
  KNOWN_STATE_VERSION,
} from "../src/utils/state.js";
import { collectStatus } from "../src/status/collect.js";
import { STATE_FILE } from "../src/utils/constants.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";
import {
  writeRawTestStateJson,
  writeTestStateJson,
  writeCorruptTestStateJson,
} from "./fixtures/state-json.js";
import { expectReadsCorruptNoBak, expectReadsOkV1 } from "./fixtures/state-read-assertions.js";

const NEWER_STATE = '{"version":3,"indexHash":"h3","sources":{}}';
const bakPath = (dir: string) => path.join(dir, STATE_FILE + ".bak");
const stateText = (dir: string) => readFile(path.join(dir, STATE_FILE), "utf-8");

/** Assert the on-disk state file was neither rewritten nor backed up. */
async function expectFileUntouched(dir: string): Promise<void> {
  expect(existsSync(bakPath(dir))).toBe(false);
  expect(await stateText(dir)).toBe(NEWER_STATE);
}

describe("readStateClassified version guard", () => {
  const env = useLintTempRoot("state-version-guard-classified");

  it("(a) reports too-new without resetting, writing, or backing up", async () => {
    await writeRawTestStateJson(env.dir, NEWER_STATE);
    const result = await readStateClassified(env.dir);
    expect(result.status).toBe("too-new");
    // Parsed state is carried, NOT reset to empty.
    expect(result.state.version).toBe(3);
    expect(result.state.indexHash).toBe("h3");
    await expectFileUntouched(env.dir);
  });

  it("(c) reports ok on a version:1 file (unchanged)", async () => {
    await expectReadsOkV1(env.dir);
  });

  it("(d) reports ok on a state at exactly KNOWN_STATE_VERSION (2)", async () => {
    expect(KNOWN_STATE_VERSION).toBe(2);
    await writeTestStateJson(env.dir, { version: 2, indexHash: "", sources: {} });
    const result = await readStateClassified(env.dir);
    expect(result.status).toBe("ok");
    expect(result.state.version).toBe(2);
  });

  it("(e) still reports corrupt on unparseable input (read-only)", async () => {
    await expectReadsCorruptNoBak(env.dir);
  });
});

describe("readState version guard", () => {
  const env = useLintTempRoot("state-version-guard-read");

  it("(b) throws StateTooNewError, writes no .bak, leaves file byte-unchanged", async () => {
    await writeRawTestStateJson(env.dir, NEWER_STATE);
    await expect(readState(env.dir)).rejects.toBeInstanceOf(StateTooNewError);
    await expect(readState(env.dir)).rejects.toThrow("written by a newer llmwiki version");
    await expectFileUntouched(env.dir);
  });

  it("(e) still backs up corrupt state to .bak (unchanged behavior)", async () => {
    await writeCorruptTestStateJson(env.dir);
    const state = await readState(env.dir);
    expect(state.sources).toEqual({});
    expect(existsSync(bakPath(env.dir))).toBe(true);
  });
});

describe("collectStatus version guard", () => {
  const env = useLintTempRoot("state-version-guard-status");

  it("surfaces too-new instead of reporting a healthy empty project", async () => {
    await writeRawTestStateJson(env.dir, NEWER_STATE);
    await env.writeSource("a.md", "# a");
    const status = await collectStatus(env.dir);
    expect(status.stateStatus).toBe("too-new");
    // Fail closed: do not invent "new" pending changes from an empty snapshot,
    // exactly as the corrupt path does.
    expect(status.pendingChanges).toEqual([]);
  });
});

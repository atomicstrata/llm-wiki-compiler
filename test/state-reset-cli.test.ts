/**
 * @file test/state-reset-cli.test.ts
 * @description Subprocess tests for the `llmwiki state reset` recovery command.
 *
 * Covers the four contract paths: a dry refusal without `--yes` (no mutation),
 * a confirmed reset that backs up and removes the state file, the recovery case
 * where the on-disk state was written by a NEWER llmwiki version (`{"version":3}`,
 * which `readState` would reject) yet `--yes` still backs it up without throwing,
 * and the no-op when there is no state file to reset.
 *
 * Plus two hardening paths: a `.llmwiki` that is a SYMLINK to an out-of-tree dir
 * fails CLOSED (the outside state file is never moved/clobbered), and a reset
 * while the project LOCK is held by a live holder refuses cleanly.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runCLI } from "./fixtures/run-cli.js";
import { STATE_FILE, LLMWIKI_DIR, LOCK_FILE } from "../src/utils/constants.js";

let root = "";

/** Write a state.json with the given JSON content under `.llmwiki/`. */
async function seedState(content: unknown): Promise<void> {
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(root, STATE_FILE), JSON.stringify(content), "utf8");
}

const STATE_PATH = (): string => path.join(root, STATE_FILE);
const BAK_PATH = (): string => `${STATE_PATH()}.bak`;

const OK_STATE = { version: 1, indexHash: "abc", sources: {} };

/**
 * Seed `content` as state.json, run a confirmed `state reset --yes`, and assert
 * the file was backed up and removed. Returns the parsed `.bak` contents so each
 * caller can assert its specific backed-up payload.
 */
async function resetAndReadBackup(content: unknown): Promise<unknown> {
  await seedState(content);
  const result = await runCLI(["state", "reset", "--yes"], root);
  expect(result.code).toBe(0);
  expect(existsSync(STATE_PATH())).toBe(false);
  expect(existsSync(BAK_PATH())).toBe(true);
  return JSON.parse(await readFile(BAK_PATH(), "utf8"));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "state-reset-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("state reset", () => {
  it("without --yes prints the plan and makes no change", async () => {
    await seedState(OK_STATE);
    const before = await readFile(STATE_PATH(), "utf8");

    const result = await runCLI(["state", "reset"], root);

    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toContain("--yes");
    expect(await readFile(STATE_PATH(), "utf8")).toBe(before);
    expect(existsSync(BAK_PATH())).toBe(false);
  });

  it("with --yes backs up and removes the state file", async () => {
    expect(await resetAndReadBackup(OK_STATE)).toEqual(OK_STATE);
  });

  it("with --yes recovers a state written by a newer llmwiki version", async () => {
    expect(await resetAndReadBackup({ version: 3 })).toEqual({ version: 3 });
  });

  it("with no state file reports nothing to reset and exits 0", async () => {
    const result = await runCLI(["state", "reset"], root);

    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toContain("No state file to reset.");
    expect(existsSync(BAK_PATH())).toBe(false);
  });

  it("fails closed when .llmwiki is a symlink to an out-of-tree dir", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "state-reset-outside-"));
    const outsideState = path.join(outside, "state.json");
    await writeFile(outsideState, JSON.stringify({ version: 3 }), "utf8");
    await symlink(outside, path.join(root, LLMWIKI_DIR), "dir");

    const result = await runCLI(["state", "reset", "--yes"], root);

    expect(result.code).not.toBe(0); // a confinement refusal is a FAILURE, not a no-op
    expect(result.stdout + result.stderr).toMatch(/escapes the project root/);
    expect(existsSync(outsideState)).toBe(true); // not moved
    expect(existsSync(`${outsideState}.bak`)).toBe(false); // not clobbered
    await rm(outside, { recursive: true, force: true });
  });

  it("refuses cleanly when the project lock is held by a live holder", async () => {
    await seedState(OK_STATE);
    // A lock naming THIS (live) process PID is not stale, so acquireLock fails.
    await writeFile(path.join(root, LOCK_FILE), String(process.pid), "utf8");

    const result = await runCLI(["state", "reset", "--yes"], root);

    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/another llmwiki process|using this project/i);
    expect(existsSync(STATE_PATH())).toBe(true); // untouched
    expect(existsSync(BAK_PATH())).toBe(false);
  });
});

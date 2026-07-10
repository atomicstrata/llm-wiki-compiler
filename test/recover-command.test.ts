/**
 * @file test/recover-command.test.ts
 * @description Subprocess tests for the `llmwiki recover` command — the
 * standalone journal-recovery escape hatch that runs the strict
 * `recoverJournalBeforeCompile` pass WITHOUT a full recompile, pairing with
 * `state reset`.
 *
 * Covers the contract paths:
 *  - a PENDING journal → reverted, reported `replayed`, exit 0, and AFTER recover
 *    `journalHealth(root)` is `ok` with no pending file left — and crucially no
 *    full compile ran;
 *  - a clean project → "nothing to recover", exit 0;
 *  - a symlink-escaping / tampered journal → prominent error, exit non-zero, and
 *    nothing outside root is touched;
 *  - the project lock held by a live holder → clean failure, exit non-zero.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { rm, writeFile, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { runCLI } from "./fixtures/run-cli.js";
import { journalHealth } from "../src/trust/journal-health.js";
import { LOCK_FILE } from "../src/utils/constants.js";
import { WIKI, makeTrustRoot, cleanupTrustRoot } from "./trust/fixture.js";
import {
  journalFile,
  pathExists,
  plantPendingTwoTargetBatch,
  plantPendingEscapingTargetBatch,
} from "./trust/journal-fixture.js";

let root = "";

/**
 * Run `recover` expecting a REFUSAL: a non-zero exit whose combined output
 * matches `messagePattern`. Shared by the refusal paths (tampered journal, lock
 * held) so each test only declares its own scenario + message.
 */
async function expectRecoverFailure(messagePattern: RegExp): Promise<void> {
  const result = await runCLI(["recover"], root);

  expect(result.code).not.toBe(0);
  expect(result.stdout + result.stderr).toMatch(messagePattern);
}

beforeEach(async () => {
  // The CLI subprocess resolves its cwd to a REALPATH; the planted journal records
  // ABSOLUTE target paths, so the fixture root must be realpath'd too or the
  // recorded targets would (spuriously) escape the realpath'd root.
  root = await realpath(await makeTrustRoot("recover-"));
});

afterEach(async () => {
  if (root) await cleanupTrustRoot(root);
  root = "";
});

describe("llmwiki recover", () => {
  it("reverts a pending journal without a full recompile and leaves journal ok", async () => {
    const { t1 } = await plantPendingTwoTargetBatch(root, WIKI, "pending");

    const result = await runCLI(["recover"], root);

    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/reverted an incomplete compile/i);
    // The strict revert restored the partially-written pre-state target.
    expect(await readFile(t1, "utf-8")).toBe("OLD-1");
    // No full compile ran, yet the journal is clean: no pending file, health ok.
    expect(await pathExists(journalFile(root, "pending"))).toBe(false);
    expect((await journalHealth(root)).status).toBe("ok");
  });

  it("reports nothing to recover for a clean project and exits 0", async () => {
    const result = await runCLI(["recover"], root);

    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/nothing to recover/i);
  });

  it("fails closed on a tampered journal naming an out-of-tree target", async () => {
    const outside = await plantPendingEscapingTargetBatch(root, "evil");

    await expectRecoverFailure(/unsafe|tamper/i);

    expect(await readFile(outside, "utf-8")).toBe("PRECIOUS"); // untouched outside root
    await rm(outside, { force: true });
  });

  it("refuses cleanly when the project lock is held by a live holder", async () => {
    await plantPendingTwoTargetBatch(root, WIKI, "pending");
    // A lock naming THIS (live) process PID is not stale, so acquireLock fails.
    await writeFile(path.join(root, LOCK_FILE), String(process.pid), "utf8");

    await expectRecoverFailure(/another llmwiki process|using this project/i);

    // The held-lock refusal must NOT have reverted the pending batch.
    expect(await pathExists(journalFile(root, "pending"))).toBe(true);
  });
});

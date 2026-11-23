/**
 * @file test/scale/downgrade-plan-file.test.ts
 * @description How `llmwiki scale downgrade --apply|--cancel <plan>` reads the
 * saved plan file (F4), through the real `scaleDowngradeCommand` with `--json`
 * in a temporary working directory. It uses the repository's plan-file policy,
 * as `catalog gc --apply` does (test/indexed/gc-cli.test.ts): a regular file
 * opened O_NOFOLLOW|O_NONBLOCK, read through one handle, never more than the
 * cap plus one byte, and always closed.
 *
 * Witnessed, for BOTH saved-plan modes:
 *  - a regular file within the cap is read whole and handed to the plan parser;
 *    non-JSON text gets the parser's own refusal;
 *  - a FIFO is refused without hanging, as are a directory, a symlink to a
 *    regular file, and a missing path. Each is a typed
 *    `scale_downgrade_invalid_plan` envelope with exit 2;
 *  - a sparse file far over the cap is refused after reading exactly cap + 1
 *    bytes;
 *  - a file that is tiny when opened and grows past the cap while being read,
 *    with every read forced short, is still refused after exactly cap + 1
 *    bytes.
 *
 * The byte counts come from a spy on the FileHandle prototype's `read`. That
 * is test-side instrumentation only; no product API is added.
 *
 * Proof limit: valid applies and cancels are not run here. A valid apply from
 * a saved plan is covered end to end by test/scale/downgrade-cli.test.ts, and
 * the cancel effects by the downgrade-cancel suites, which call
 * cancelScaleDowngrade directly. Both modes share the one read changed here.
 */

import { execFileSync } from "node:child_process";
import { mkdir, open, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { scaleDowngradeCommand } from "../../src/commands/scale-downgrade.js";
import { jsonCommand } from "../catalog/cli-helpers.js";
import { useTemporaryCwd } from "../fixtures/temporary-cwd.js";

/** The command's plan-file cap (src/commands/scale-downgrade.ts MAX_PLAN_FILE_BYTES). */
const PLAN_CAP_BYTES = 16 * 1024 * 1024;
/** A sparse size far over the cap; only cap + 1 bytes of it may ever be read. */
const FAR_OVER_CAP_BYTES = 4 * PLAN_CAP_BYTES;
/** The largest single read the growth witness lets through, so reads come back short. */
const SHORT_READ_BYTES = 1024 * 1024;
const MODES = ["apply", "cancel"] as const;
type Mode = (typeof MODES)[number];
type Envelope = { refusal?: { code: string; message: string } };

let root: string;
useTemporaryCwd("llmwiki-downgrade-plan-", async (dir) => { root = dir; });

/** Run `scale downgrade --<mode> <file> --readers-offline --json`; returns the exit code and the envelope. */
function downgrade(mode: Mode, file: string): Promise<{ code: number; envelope: Envelope }> {
  return jsonCommand(() => scaleDowngradeCommand({ [mode]: file, readersOffline: true, json: true }));
}

/** The exact typed refusal (exit 2) with `message`. */
function invalidPlan(message: string): { code: number; envelope: Envelope } {
  return { code: 2, envelope: expect.objectContaining({ refusal: { code: "scale_downgrade_invalid_plan", message: `scale_downgrade_invalid_plan: ${message}` } }) };
}

/**
 * Spy on the FileHandle prototype's `read`, counting the bytes it actually returns.
 * Each request is capped at `maxRequest` bytes, and `beforeFirst` runs once before the first read.
 */
async function spyReads(maxRequest = Number.MAX_SAFE_INTEGER, beforeFirst?: () => Promise<void>): Promise<{ calls: number; bytes: number }> {
  const probe = await open(path.join(root, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as { read: (...args: any[]) => Promise<{ bytesRead: number }> };
  await probe.close();
  const original = prototype.read;
  const seen = { calls: 0, bytes: 0 };
  vi.spyOn(prototype, "read").mockImplementation(async function (this: unknown, buffer: Buffer, offset: number, length: number, position: number) {
    if (seen.calls++ === 0 && beforeFirst) await beforeFirst();
    const result = await original.call(this, buffer, offset, Math.min(length, maxRequest), position);
    seen.bytes += result.bytesRead;
    return result;
  });
  return seen;
}

describe("a regular plan file within the cap", () => {
  it.each(MODES)("is read whole and parsed (--%s)", async (mode) => {
    await writeFile(path.join(root, "text.json"), "not a plan");
    expect(await downgrade(mode, path.join(root, "text.json"))).toEqual(invalidPlan("the plan is not valid JSON"));
  });
});

describe("an unusable plan path", () => {
  it.each(MODES)("refuses a FIFO without hanging, a directory, a symlink and a missing path (--%s)", async (mode) => {
    execFileSync("mkfifo", [path.join(root, "plan.fifo")]);
    await mkdir(path.join(root, "plan.dir"));
    await writeFile(path.join(root, "real.json"), "{}");
    await symlink(path.join(root, "real.json"), path.join(root, "plan.link"));
    const expected: ReadonlyArray<[string, string]> = [["plan.fifo", "is not a regular file"], ["plan.dir", "is not a regular file"],
      ["plan.link", "cannot be opened as a regular file"], ["missing.json", "cannot be opened as a regular file"]];
    for (const [name, why] of expected) {
      const file = path.join(root, name);
      expect([name, await downgrade(mode, file)]).toEqual([name, invalidPlan(`${file} ${why}`)]);
    }
  });
});

describe("the plan-file cap bounds the bytes actually read", () => {
  it.each(MODES)("refuses a sparse file far over the cap after reading cap + 1 bytes (--%s)", async (mode) => {
    const file = path.join(root, "big.json");
    await writeFile(file, "");
    await truncate(file, FAR_OVER_CAP_BYTES);
    const reads = await spyReads();
    expect(await downgrade(mode, file)).toEqual(invalidPlan(`${file} is larger than a plan`));
    expect([reads.calls > 0, reads.bytes]).toEqual([true, PLAN_CAP_BYTES + 1]);
  });

  it.each(MODES)("refuses a file that grows past the cap during short reads, after cap + 1 bytes (--%s)", async (mode) => {
    const file = path.join(root, "growing.json");
    await writeFile(file, "{}");
    const reads = await spyReads(SHORT_READ_BYTES, () => truncate(file, FAR_OVER_CAP_BYTES));
    expect(await downgrade(mode, file)).toEqual(invalidPlan(`${file} is larger than a plan`));
    expect([reads.calls > 1, reads.bytes]).toEqual([true, PLAN_CAP_BYTES + 1]);
  });
});

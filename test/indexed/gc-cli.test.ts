/**
 * @file test/indexed/gc-cli.test.ts
 * @description `llmwiki catalog gc` refuses an unusable plan file with a typed
 * JSON envelope (exit 2) before anything else runs: a FIFO is rejected
 * without hanging, as are a directory, a symlink, a file over the cap, and
 * non-JSON text; `--apply` with `--out` is refused as a conflict.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { catalogGcCommand } from "../../src/commands/catalog-maintenance.js";
import { jsonCommand } from "../catalog/cli-helpers.js";

const OVER_CAP_BYTES = 16 * 1024 * 1024 + 1;
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-gc-cli-")); vi.spyOn(process, "cwd").mockReturnValue(root); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

/** Expect `catalog gc --apply <name>` to refuse each of `names` as an invalid plan. */
async function expectInvalidPlans(names: readonly string[]): Promise<void> {
  for (const name of names) {
    const { code, envelope } = await gc({ apply: path.join(root, name) });
    expect([name, code, envelope.refusal?.code]).toEqual([name, 2, "indexed_gc_plan_invalid"]);
  }
}

/** Run `catalog gc --json` with `options`; returns the exit code and the envelope. */
function gc(options: { apply?: string; out?: string }): Promise<{ code: number; envelope: { refusal?: { code: string } } }> {
  return jsonCommand(() => catalogGcCommand({ ...options, json: true, readersOffline: true }));
}

describe("unusable plan files", () => {
  it("refuses a FIFO without hanging, a directory and a symlink", async () => {
    const fifo = path.join(root, "plan.fifo");
    execFileSync("mkfifo", [fifo]);
    await mkdir(path.join(root, "plan.dir"));
    await writeFile(path.join(root, "real.json"), "{}");
    await symlink(path.join(root, "real.json"), path.join(root, "plan.link"));
    await expectInvalidPlans(["plan.fifo", "plan.dir", "plan.link"]);
  });

  it("refuses a file over the cap and non-JSON text", async () => {
    await writeFile(path.join(root, "big.json"), "");
    await truncate(path.join(root, "big.json"), OVER_CAP_BYTES);
    await writeFile(path.join(root, "text.json"), "not a plan");
    await expectInvalidPlans(["big.json", "text.json"]);
  });

  it("refuses --apply combined with --out", async () => {
    const { code, envelope } = await gc({ apply: path.join(root, "a.json"), out: path.join(root, "b.json") });
    expect([code, envelope.refusal?.code]).toEqual([2, "indexed_gc_plan_invalid"]);
  });
});

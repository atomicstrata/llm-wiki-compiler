/**
 * @file test/scale/downgrade-cli-options.test.ts
 * @description Operator-option validation of `llmwiki scale downgrade`
 * through the real `scaleDowngradeCommand` with `--json`, its stdout captured
 * (nothing else is replaced: no backend, no working-directory change, no child
 * process, no indexed fixture).
 *
 * The saved-plan paths do not exist. A plan read would be refused with a
 * different message (`<path> cannot be opened as a regular file`), so each
 * exact refusal below also shows that the options were refused BEFORE any read.
 *
 * Witnessed: naming both `--apply` and `--cancel` is refused first, even with
 * preview options; each preview-only option (`--out`, `--target`, `--size`,
 * `--documents`) with either saved-plan mode is refused; with no saved plan
 * the command reaches the preview's own target validation. Each is the exact
 * versioned refusal envelope with exit code 2.
 *
 * Proof limit: valid applies and cancels are not run here; their effects rest
 * on source review and the existing integration witnesses.
 */

import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { scaleDowngradeCommand, type ScaleDowngradeCommandOptions } from "../../src/commands/scale-downgrade.js";

/** A saved-plan path that does not exist. */
const missingPlan = (): string => path.join(os.tmpdir(), `llmwiki-no-such-plan-${randomUUID()}.json`);
/** The refusal exit code of a typed refusal. */
const EXIT_REFUSED = 2;
/** The two saved-plan refusal messages and the preview's target refusal. */
const BOTH_MODES = "give --apply or --cancel, not both";
const PREVIEW_OPTION = "--apply and --cancel take only the saved plan: preview with --target and an estimate first";
const BAD_TARGET = "--target must be local-standard or local-large";

/** Run the real command with `--json`, capturing stdout; returns its exit code and parsed envelope. */
async function run(options: ScaleDowngradeCommandOptions): Promise<{ code: number; envelope: unknown }> {
  const written: string[] = [];
  const capture = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
  try {
    const code = await scaleDowngradeCommand({ ...options, json: true });
    return { code, envelope: JSON.parse(written.join("")) };
  } finally {
    capture.mockRestore();
  }
}

/** The exact versioned refusal envelope (exit 2) of `code` with `message`. */
function refused(code: string, message: string): { code: number; envelope: unknown } {
  return { code: EXIT_REFUSED, envelope: { version: 1, command: "scale downgrade", ok: false, refusal: { code, message: `${code}: ${message}` } } };
}

describe("naming both saved-plan modes", () => {
  it("is refused first, with or without preview options", async () => {
    expect(await run({ apply: missingPlan(), cancel: missingPlan() })).toEqual(refused("scale_downgrade_invalid_plan", BOTH_MODES));
    const withPreview = { apply: missingPlan(), cancel: missingPlan(), out: missingPlan(), target: "local-standard", size: "1MB", documents: "5" };
    expect(await run(withPreview)).toEqual(refused("scale_downgrade_invalid_plan", BOTH_MODES));
  });
});

describe("a preview-only option with a saved-plan mode", () => {
  const previewOptions: ReadonlyArray<[keyof ScaleDowngradeCommandOptions, string]> = [
    ["out", "plan-out.json"], ["target", "local-standard"], ["size", "1MB"], ["documents", "5"],
  ];
  const cases = previewOptions.flatMap(([option, value]) => (["apply", "cancel"] as const).map((mode) => [option, value, mode] as const));

  it.each(cases)("--%s with --%s is refused before any plan read", async (option, value, mode) => {
    expect(await run({ [mode]: missingPlan(), [option]: value })).toEqual(refused("scale_downgrade_invalid_plan", PREVIEW_OPTION));
  });
});

describe("no saved-plan mode", () => {
  it("reaches the preview's target validation", async () => {
    expect(await run({ target: "nowhere", size: "1MB" })).toEqual(refused("scale_invalid_request", BAD_TARGET));
    expect(await run({})).toEqual(refused("scale_invalid_request", BAD_TARGET));
  });
});

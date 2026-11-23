/**
 * @file test/storage-test-profile.test.ts
 * @description The explicit storage profile behind the default per-test and
 * per-hook budgets (explicit test and hook timeouts are unaffected).
 *
 * Unset or "default" keeps the 30 s per-test and 60 s per-hook reference
 * budgets, silently; only the exact name "slow-durable-storage" selects the
 * fixed 300 s and 600 s budgets, and it always comes with a notice naming the
 * profile, both of its budgets and both reference budgets. Every other value,
 * the empty string and near misses included, fails closed with ONE fixed
 * message that never repeats the rejected value.
 *
 * The last two cases bind both budgets to where the Bun run really applies them,
 * under whatever profile this run selected:
 *  - per test: `bunTestBudgetArguments` gives `bun test --timeout <profile budget>`,
 *    and the repository runner `scripts/run-tests.mjs` (which this test never runs: it
 *    mounts a RAM disk) passes exactly those arguments and no other `--timeout`;
 *  - per hook: Bun has no runner-wide hook budget, so `storage-profile-hooks.ts` gives
 *    every hook registered through it the profile's budget as its explicit timeout,
 *    and keeps a hook's own timeout unchanged.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { bunTestBudgetArguments, resolveStorageTestProfile } from "./config/storage-test-profile.js";
import { hookOptions, PROFILE_HOOK_TIMEOUT_MS, withProfileBudget, type HookOptions } from "./config/storage-profile-hooks.js";

/** The one message any unrecognized value produces. */
const REJECTION = 'LLMWIKI_TEST_STORAGE_PROFILE must be unset, "default" or "slow-durable-storage"';

/** The reference profile: 30 s per test, 60 s per hook, no notice. */
const REFERENCE = { profile: "default", testTimeoutMs: 30_000, hookTimeoutMs: 60_000, notice: null };

/** The profile this run selected. */
const SELECTED = resolveStorageTestProfile(process.env.LLMWIKI_TEST_STORAGE_PROFILE);

describe("the storage test profile", () => {
  it("keeps the 30 s and 60 s reference budgets, silently, when the variable is unset", () => {
    expect(resolveStorageTestProfile(undefined)).toEqual(REFERENCE);
  });

  it("keeps the same reference budgets for an explicit \"default\"", () => {
    expect(resolveStorageTestProfile("default")).toEqual(REFERENCE);
  });

  it("selects 300 s per test and 600 s per hook for the exact slow-durable-storage name, and announces it", () => {
    const profile = resolveStorageTestProfile("slow-durable-storage");
    expect([profile.profile, profile.testTimeoutMs, profile.hookTimeoutMs]).toEqual(["slow-durable-storage", 300_000, 600_000]);
    // The notice names the profile, BOTH slow budgets and BOTH reference budgets, so the run cannot pass for a reference run.
    for (const part of ["slow-durable-storage", "300000 ms", "600000 ms", "30000 ms", "60000 ms", "do not establish the reference budgets"]) {
      expect(profile.notice).toContain(part);
    }
  });

  it.each(["", " ", "slow", "SLOW-DURABLE-STORAGE", " slow-durable-storage", "slow-durable-storage ", "90000", "Default"])(
    "rejects %j with the fixed message",
    (value) => {
      expect(() => resolveStorageTestProfile(value)).toThrow(new Error(REJECTION));
      expect(() => bunTestBudgetArguments(value)).toThrow(new Error(REJECTION));
    },
  );

  it("never repeats the rejected value in its message", () => {
    const secretLike = "sk-not-a-real-token-1234567890";
    expect(() => resolveStorageTestProfile(secretLike)).toThrow(REJECTION);
    let message = "";
    try { resolveStorageTestProfile(secretLike); } catch (error) { message = (error as Error).message; }
    expect(message).not.toContain(secretLike);
  });
});

describe("the storage test profile", () => {
  it("is the per-test budget the Bun runner passes, for both profiles and for this run", () => {
    expect(bunTestBudgetArguments(undefined)).toEqual(["--timeout", "30000"]);
    expect(bunTestBudgetArguments("slow-durable-storage")).toEqual(["--timeout", "300000"]);
    expect(bunTestBudgetArguments(process.env.LLMWIKI_TEST_STORAGE_PROFILE)).toEqual(["--timeout", String(SELECTED.testTimeoutMs)]);
    const runner = readFileSync(path.resolve("scripts/run-tests.mjs"), "utf8");
    expect(runner).toContain('import { bunTestBudgetArguments, resolveStorageTestProfile } from "../test/config/storage-test-profile.ts";');
    expect(runner).toContain("const TEST_BUDGET_ARGUMENTS = bunTestBudgetArguments(process.env.LLMWIKI_TEST_STORAGE_PROFILE);");
    expect(runner).toContain("...TEST_BUDGET_ARGUMENTS, ...process.argv.slice(2)];");
    expect(runner.match(/"--timeout"/gu)).toBeNull();
  });

  it("is the per-hook budget every hook registered through the profile hooks gets, unless it states its own", () => {
    expect(PROFILE_HOOK_TIMEOUT_MS).toBe(SELECTED.hookTimeoutMs);
    expect([hookOptions(undefined, 600_000), hookOptions({}, 600_000)]).toEqual([600_000, { timeout: 600_000 }]);
    expect([hookOptions(2_000, 600_000), hookOptions({ timeout: 120_000 }, 600_000)]).toEqual([2_000, { timeout: 120_000 }]);
    const registered: Array<HookOptions | undefined> = [];
    const hook = withProfileBudget((_body, options) => { registered.push(options); }, 60_000);
    hook(() => undefined);
    hook(() => undefined, 300_000);
    expect(registered).toEqual([60_000, 300_000]);
  });
});

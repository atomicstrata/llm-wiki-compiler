/**
 * @file test/config/storage-test-profile.ts
 * @description The explicit storage profile that selects the DEFAULT per-test
 * and per-hook budgets of the Bun test run (a test or hook that sets its own
 * timeout keeps it). The per-test budget reaches `bun test` as `--timeout`
 * through {@link bunTestBudgetArguments} (used by `scripts/run-tests.mjs`); Bun
 * 1.4.2 has no runner-wide hook budget, so the per-hook budget is applied as an
 * explicit timeout argument by `test/config/storage-profile-hooks.ts` to every
 * hook registered through it.
 *
 * Durable writes end in full device flushes, so a test's runtime on spinning
 * external storage is dominated by flush latency rather than by its logic.
 * The reference budgets stay 30 s per test and 60 s per hook. A caller who
 * runs the suite on slow durable storage may opt in, by exact name, to larger
 * fixed budgets; no storage is ever detected automatically, no budget is
 * unbounded, and an unrecognized value fails closed with a fixed message that
 * never echoes the value it rejected (environment values can carry anything).
 *
 * Why the slow budgets are 300 s and 600 s: in a broad run on slow external
 * storage, two durable fixture setup hooks exceeded the then-fixed 60 s hook
 * budget (18 flushes taking 52.1 s, and 59 taking 59.0 s, before the timeout)
 * and one durable case exceeded the then 90 s case budget (82 flushes taking
 * 87.5 s). Their setup and assertions never completed, so those runs neither
 * showed a product defect nor ruled one out. A pass under these budgets shows
 * functional behaviour on slow storage only, never the reference budgets.
 *
 * The function is pure: the caller passes the environment value in, and the
 * caller decides how to show the returned notice.
 */

/** The reference per-test budget, used unless slow storage is named explicitly. */
const DEFAULT_TEST_TIMEOUT_MS = 30_000;

/** The reference per-hook budget, used unless slow storage is named explicitly. */
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

/** The opt-in per-test budget for slow durable storage (spinning disks). */
const SLOW_DURABLE_STORAGE_TEST_TIMEOUT_MS = 300_000;

/** The opt-in per-hook budget for slow durable storage, where fixture setup flushes many times. */
const SLOW_DURABLE_STORAGE_HOOK_TIMEOUT_MS = 600_000;

/** Fixed rejection message: names the accepted values, never the rejected one. */
const UNKNOWN_PROFILE_MESSAGE =
  'LLMWIKI_TEST_STORAGE_PROFILE must be unset, "default" or "slow-durable-storage"';

/** Shown whenever the opt-in profile is active, so a run cannot pass for a reference run. */
const SLOW_PROFILE_NOTICE =
  "llmwiki tests: storage profile slow-durable-storage, per-test budget 300000 ms and per-hook budget 600000 ms " +
  "(reference budgets 30000 ms per test and 60000 ms per hook); results show functional behaviour only " +
  "and do not establish the reference budgets";

/** The selected profile, its per-test and per-hook budgets, and the notice to show (if any). */
interface StorageTestProfile {
  readonly profile: "default" | "slow-durable-storage";
  readonly testTimeoutMs: number;
  readonly hookTimeoutMs: number;
  readonly notice: string | null;
}

/**
 * Resolve the storage profile from the raw `LLMWIKI_TEST_STORAGE_PROFILE` value.
 *
 * @param value - The environment value, or `undefined` when unset. Only an
 *   exact `"default"` or `"slow-durable-storage"` is accepted; anything else,
 *   including the empty string, throws.
 * @returns The profile with its fixed per-test and per-hook budgets and optional notice.
 * @throws Error with a fixed message for any unrecognized value.
 */
export function resolveStorageTestProfile(value: string | undefined): StorageTestProfile {
  if (value === undefined || value === "default") {
    return { profile: "default", testTimeoutMs: DEFAULT_TEST_TIMEOUT_MS, hookTimeoutMs: DEFAULT_HOOK_TIMEOUT_MS, notice: null };
  }
  if (value === "slow-durable-storage") {
    return {
      profile: "slow-durable-storage",
      testTimeoutMs: SLOW_DURABLE_STORAGE_TEST_TIMEOUT_MS,
      hookTimeoutMs: SLOW_DURABLE_STORAGE_HOOK_TIMEOUT_MS,
      notice: SLOW_PROFILE_NOTICE,
    };
  }
  throw new Error(UNKNOWN_PROFILE_MESSAGE);
}

/**
 * The `bun test` arguments that carry the selected profile's default per-test budget.
 *
 * @param value - The raw `LLMWIKI_TEST_STORAGE_PROFILE` value (validated as {@link resolveStorageTestProfile} does).
 * @returns `["--timeout", "<ms>"]` for the profile's per-test budget.
 * @throws Error with the fixed message for any unrecognized value.
 */
export function bunTestBudgetArguments(value: string | undefined): string[] {
  return ["--timeout", String(resolveStorageTestProfile(value).testTimeoutMs)];
}

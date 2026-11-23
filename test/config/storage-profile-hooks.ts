/**
 * @file test/config/storage-profile-hooks.ts
 * @description `beforeAll`, `beforeEach`, `afterAll` and `afterEach` with the
 * storage profile's per-hook budget as their DEFAULT timeout.
 *
 * Bun 1.4.2 has no runner-wide hook timeout (`bun test --help` offers only a
 * per-test `--timeout`), but every lifecycle hook accepts its own timeout as
 * its second argument (`options?: number | { timeout?: number }` in the
 * bun-types of that release). These wrappers pass exactly that documented
 * argument: a hook that states its own timeout keeps it unchanged, and a hook
 * that does not gets the selected profile's per-hook budget (60 s reference,
 * 600 s for the explicit slow-durable-storage profile). Nothing in Bun is
 * patched. An unrecognized profile value throws when this module loads, so a
 * file that registers its hooks here cannot run under an unknown profile.
 *
 * Scope: the files that import their hooks from here. Hooks registered
 * directly from `bun:test` are NOT covered and keep Bun's own behaviour.
 */

import { afterAll as bunAfterAll, afterEach as bunAfterEach, beforeAll as bunBeforeAll, beforeEach as bunBeforeEach } from "bun:test";
import { resolveStorageTestProfile } from "./storage-test-profile.js";

/** A hook body, as `bun:test` accepts it (with or without a `done` callback). */
type HookBody = Parameters<typeof bunBeforeAll>[0];

/** A hook's own options, as `bun:test` accepts them: a timeout in ms, or `{ timeout }`. */
export type HookOptions = number | { timeout?: number };

/** A `bun:test` hook registration function. */
type RegisterHook = (body: HookBody, options?: HookOptions) => void;

/** The selected profile's per-hook budget (an unknown profile throws here, with the profile's fixed message). */
export const PROFILE_HOOK_TIMEOUT_MS = resolveStorageTestProfile(process.env.LLMWIKI_TEST_STORAGE_PROFILE).hookTimeoutMs;

/**
 * The options a hook registers with: its own timeout when it states one, otherwise the budget.
 *
 * @param options - The hook's own options, if any.
 * @param budget - The default per-hook budget (the profile's by default).
 * @returns `options` unchanged when it carries a timeout; otherwise the budget (kept inside an options object).
 */
export function hookOptions(options: HookOptions | undefined, budget: number = PROFILE_HOOK_TIMEOUT_MS): HookOptions {
  if (typeof options === "number") return options;
  if (options === undefined) return budget;
  return options.timeout === undefined ? { ...options, timeout: budget } : options;
}

/**
 * Wrap one hook registration so a hook without its own timeout gets the budget.
 *
 * @param register - The `bun:test` registration function.
 * @param budget - The default per-hook budget (the profile's by default).
 * @returns A registration function with the same signature.
 */
export function withProfileBudget(register: RegisterHook, budget: number = PROFILE_HOOK_TIMEOUT_MS): RegisterHook {
  return (body, options) => register(body, hookOptions(options, budget));
}

/** `beforeAll` with the profile's per-hook budget as its default timeout. */
export const beforeAll = withProfileBudget(bunBeforeAll as RegisterHook);
/** `beforeEach` with the profile's per-hook budget as its default timeout. */
export const beforeEach = withProfileBudget(bunBeforeEach as RegisterHook);
/** `afterAll` with the profile's per-hook budget as its default timeout. */
export const afterAll = withProfileBudget(bunAfterAll as RegisterHook);
/** `afterEach` with the profile's per-hook budget as its default timeout. */
export const afterEach = withProfileBudget(bunAfterEach as RegisterHook);

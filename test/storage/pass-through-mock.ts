/**
 * @file test/storage/pass-through-mock.ts
 * @description The pass-through module mock the whole-consumer binding suites use
 * to show that a ROOT route still reaches its root-taking functions and a BOUND
 * route reaches none (`context-pack-binding.test.ts`,
 * `query-answer-binding.test.ts`, `query-publication-binding.test.ts`).
 *
 * `vi.mock(path, () => passThrough(realModule, name))` keeps every export of the
 * module real and wraps the one named export in a `vi.fn` that calls the real
 * function, so the suite can count its calls without changing what it does.
 * `realModule` must be a copy of the module taken BEFORE `vi.mock` runs: Bun
 * replaces the module's exports in place, so a later read would see the spy.
 */

import { vi } from "bun:test";

/** The real module, with export `name` wrapped in a pass-through spy. */
export function passThrough(realModule: object, name: string): Record<string, unknown> {
  const actual = realModule as Record<string, unknown>;
  return { ...actual, [name]: vi.fn(actual[name] as (...args: never[]) => unknown) };
}

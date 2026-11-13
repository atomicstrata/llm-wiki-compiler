/**
 * @file test/mocked.ts
 * @description View a module-mocked or spied function as its `Mock`.
 *
 * `vi.mock` and `vi.spyOn` replace a function with a mock at runtime, but its
 * import keeps the original's type. bun-types has no `vi.mocked` (`jest.mocked`)
 * to bridge that, so this is it: a type-only view, read at each call site, so
 * it always sees whatever the binding holds at that moment.
 */

import type { Mock } from "bun:test";

/** `fn`, typed as the mock that replaced it. */
export function mocked<T extends (...args: never[]) => unknown>(fn: T): Mock<T> {
  return fn as unknown as Mock<T>;
}

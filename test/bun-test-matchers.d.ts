/**
 * @file test/bun-test-matchers.d.ts
 * @description Equality and containment matchers accept any expected value, as under vitest.
 *
 * bun-types types `toBe`/`toEqual`/`toStrictEqual`'s expected value as the
 * received type `T`. Suites routinely compare a branded or literal-union result
 * against a plain object literal (`{ status: "held" }` widens to `string`),
 * which is the same comparison at runtime but fails to type-check. The runtime
 * matcher already compares any value; this only widens its declared parameter.
 */

import "bun:test";

declare module "bun:test" {
  interface Matchers<T> {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toStrictEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toContainEqual(expected: unknown): void;
  }
}

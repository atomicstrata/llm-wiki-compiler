/**
 * @file test/scale/downgrade-vectors.test.ts
 * @description Scale-down snapshots distinguish unavailable, absent, and valid empty vectors.
 */

import { expect, it } from "bun:test";
import { vectorsFromStoredRead } from "./fixtures/downgrade-vectors.js";

it("refuses an unreadable embedding store", () => {
  expect(() => vectorsFromStoredRead({ kind: "unavailable", reason: "corrupt binary" }, false))
    .toThrow("corrupt binary");
});

it("refuses a missing store when the layout requires vectors", () => {
  expect(() => vectorsFromStoredRead({ kind: "absent" }, true)).toThrow("required embedding store is absent");
});

it("allows a valid empty standard project but keeps seeded vectors", () => {
  expect(vectorsFromStoredRead({ kind: "absent" }, false)).toEqual({});
  const parsed = { kind: "parsed", parsed: { version: 3, store: { entries: [{ pageId: "concepts/a", vector: [0.5] }] } } } as const;
  expect(vectorsFromStoredRead(parsed, true)).toEqual({ "concepts/a": [0.5] });
});

/**
 * @file test/portable/disk-replacing-record-entries.test.ts
 * @description Exact-boundary regressions of `isReplacingRecordTemp` (CP192):
 * the one non-record entry a `<id>.json` ledger directory may hold after a
 * crash, the replacing writer's `<safeId>.json.<16 lowercase hex>.tmp` regular
 * sibling.
 *
 * Only that exact shape is recognised: the stem must be a safe record id
 * (including the maximum length), the nonce exactly 16 lowercase hex digits,
 * the entry a regular file. Near misses, the create-only writer's
 * `.json.tmp` / `.json.writing`, canonical `.json` names, nonregular entries
 * and the exact shape followed by any line terminator (LF, CR, CRLF, U+2028,
 * U+2029) are not. These pin classification only; they are not a durability
 * witness.
 *
 * STATUS: UNRUN when written (CP192; terminator cases added CP193). Pure:
 * no filesystem, store or import beyond the predicate and its safe-id rule.
 */

import { describe, expect, it } from "bun:test";
import { isReplacingRecordTemp } from "../../src/portable/store/disk-record-entries.js";

const NONCE = "0123456789abcdef";
/** The longest safe record id: one leading character plus 200 more. */
const MAX_STEM = `a${"b".repeat(200)}`;

/** Classify `name` as a regular entry. */
function regular(name: string): boolean {
  return isReplacingRecordTemp({ name, regular: true });
}

describe("replacing-write temp: the exact shape is recognised", () => {
  it("accepts a safe stem with a 16-digit lowercase hex nonce", () => {
    expect(regular(`op_a.json.${NONCE}.tmp`)).toBe(true);
  });

  it("accepts stems that contain dots or suffix-like parts", () => {
    for (const stem of ["op.v2", "op_x.json.tmp", "op_y.json.writing", `op.json.${NONCE}`]) {
      expect(regular(`${stem}.json.${NONCE}.tmp`)).toBe(true);
    }
  });

  it("accepts the maximum-length safe stem and refuses one character more", () => {
    expect(regular(`${MAX_STEM}.json.${NONCE}.tmp`)).toBe(true);
    expect(regular(`${MAX_STEM}c.json.${NONCE}.tmp`)).toBe(false);
  });
});

describe("replacing-write temp: everything else is not one", () => {
  it("refuses unsafe stems", () => {
    for (const stem of ["", ".hidden", "-lead", "a..b", "a/b", "a b"]) {
      expect(regular(`${stem}.json.${NONCE}.tmp`)).toBe(false);
    }
  });

  it("refuses a nonce that is uppercase, short, long or not hex", () => {
    for (const nonce of [NONCE.toUpperCase(), NONCE.slice(1), `${NONCE}0`, `${NONCE.slice(1)}g`]) {
      expect(regular(`op_a.json.${nonce}.tmp`)).toBe(false);
    }
  });

  it("refuses near misses and the create-only writer's siblings", () => {
    const names = [`op_a.json.${NONCE}.tmpx`, `op_a.json.${NONCE}`, `op_a.${NONCE}.tmp`, `op_a.json.${NONCE}.tmp.bak`,
      "op_a.json.tmp", "op_a.json.writing", `op_a.json..${NONCE}.tmp`];
    for (const name of names) expect(regular(name)).toBe(false);
  });

  it("refuses canonical names that end in .json, however temp-like their id", () => {
    for (const name of ["op_a.json", `op_a.json.${NONCE}.tmp.json`]) expect(regular(name)).toBe(false);
  });

  it("refuses a nonregular entry even with the exact name", () => {
    expect(isReplacingRecordTemp({ name: `op_a.json.${NONCE}.tmp`, regular: false })).toBe(false);
  });
});

describe("replacing-write temp: no trailing line terminator is ever accepted", () => {
  it("refuses the exact shape followed by LF, CR, CRLF, U+2028 or U+2029", () => {
    for (const terminator of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
      expect(regular(`op_a.json.${NONCE}.tmp${terminator}`)).toBe(false);
      expect(regular(`${MAX_STEM}.json.${NONCE}.tmp${terminator}`)).toBe(false);
    }
  });
});

/**
 * @file test/parity/golden.ts
 * @description Golden-snapshot helper for the CLP Phase 0 parity baseline.
 *
 * `assertGolden(name, value, opts?)` canonicalizes `value` to JSON with
 * sorted object keys (so key-order churn never produces a spurious diff),
 * strips volatile fields named in `opts.volatile` (wherever they appear in
 * the tree, e.g. `exportedAt`, `generatedAt`, absolute roots), and compares
 * against `test/parity/__golden__/<name>.json`.
 *
 * Update mode: when `process.env.UPDATE_GOLDEN` is set, the canonicalized
 * value is WRITTEN to the golden file instead of asserted — this is how the
 * baseline is (re)generated. Without the flag the helper deep-equals the
 * live value against the stored golden and fails on any drift.
 *
 * Order-insensitive collections: pass field paths in `opts.unordered` (top-
 * level field names whose array values are compared as sorted sets) for
 * surfaces where collection order is not guaranteed.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

/** Directory holding the committed golden snapshots. */
const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__golden__");

/** Options controlling normalization before comparison. */
export interface GoldenOptions {
  /** Field names to delete anywhere they occur in the tree (volatile values). */
  volatile?: string[];
  /** Top-level field names whose array values are sorted before comparison. */
  unordered?: string[];
}

/**
 * Recursively rebuild `value` with object keys sorted and any field named in
 * `volatile` removed. Arrays preserve order (order-sensitivity is handled
 * separately via `unordered`). Primitives pass through unchanged.
 */
function canonicalize(value: unknown, volatile: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, volatile));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (volatile.has(key)) continue;
      out[key] = canonicalize((value as Record<string, unknown>)[key], volatile);
    }
    return out;
  }
  return value;
}

/** Stably stringify an arbitrary value for set comparison of unordered arrays. */
function stableKey(item: unknown): string {
  return JSON.stringify(item);
}

/**
 * Sort the array values of any top-level field listed in `unordered` so
 * collections whose order is not guaranteed compare as sets. Runs AFTER
 * canonicalization so the sort sees already-normalized members.
 */
function applyUnordered(value: unknown, unordered: string[]): unknown {
  if (unordered.length === 0 || value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };
  for (const field of unordered) {
    const arr = obj[field];
    if (Array.isArray(arr)) {
      out[field] = [...arr].sort((a, b) => stableKey(a).localeCompare(stableKey(b)));
    }
  }
  return out;
}

/** Produce the fully normalized snapshot value for `value` under `opts`. */
function normalize(value: unknown, opts: GoldenOptions): unknown {
  const canonical = canonicalize(value, new Set(opts.volatile ?? []));
  return applyUnordered(canonical, opts.unordered ?? []);
}

/**
 * Assert that `value` matches the stored golden snapshot named `name`, or
 * write the golden when `UPDATE_GOLDEN` is set. Returns nothing; throws via
 * vitest's `expect` on mismatch.
 *
 * @param name - Golden file basename (without extension); also the surface id.
 * @param value - The captured surface value to snapshot.
 * @param opts - Optional volatile-field stripping and unordered-field config.
 */
export function assertGolden(name: string, value: unknown, opts: GoldenOptions = {}): void {
  const normalized = normalize(value, opts);
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;

  if (process.env.UPDATE_GOLDEN) {
    if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, serialized, "utf-8");
    return;
  }

  expect(existsSync(file), `Missing golden for "${name}". Run with UPDATE_GOLDEN=1 to create it.`).toBe(true);
  const expected = JSON.parse(readFileSync(file, "utf-8"));
  expect(normalized, `Golden drift for surface "${name}"`).toEqual(expected);
}

/**
 * @file Shared scale-admission test fixtures: a recursive per-entry tree witness and the constructed
 * empty `local-indexed` scale-down plan several admission suites plant.
 *
 * They replace blocks the suites carried inline, without changing what each suite observes: the tree
 * walk takes the suite's own per-entry formatter (so every recorded state string is byte-identical to
 * the inline version), and the plan keeps the exact property order of the inline literal, because the
 * suites write it with `JSON.stringify` (the digest itself uses `canonicalize`, which is order-free).
 */
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import canonicalize from "canonicalize";
import { DOWNGRADE_PLAN_FORMAT } from "../../../src/scale/downgrade-contracts.js";

/** Every entry under `root` (recursive, in `readdir` order) mapped to `describe(absolutePath, bigint stats)`. */
export async function entryStates(root: string, describe: (file: string, info: BigIntStats) => Promise<string>): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  for (const name of await readdir(root, { recursive: true })) {
    const file = path.join(root, name);
    state[name] = await describe(file, await lstat(file, { bigint: true }));
  }
  return state;
}

/**
 * The digest-bound plan of an empty `local-indexed` scale-down to `target` from the revision-7 record
 * hashing to `originalSha` (no stores, units, runs or pins), and its fence-8 journal directory.
 */
export function emptyDowngradePlan<R>(root: string, target: string, originalSha: string, requested: R) {
  const inventory = {
    from: "local-indexed", target, record: { revision: 7, sha256: originalSha }, requested,
    measured: { sourceDocuments: 0, sourceBytes: 0, wikiFiles: 0, wikiBytes: 0 },
    freeze: { entries: 0, bytes: 0, digest: "" }, stores: [], units: [], priors: [], runs: [],
    lastRun: null, pins: { labels: [], digest: "" }, capabilities: [], notices: [], blockers: [],
  };
  const body = { format: DOWNGRADE_PLAN_FORMAT, version: 1, root, inventory };
  const plan = { ...body, digest: createHash("sha256").update(canonicalize(body)!).digest("hex") };
  return { plan, dir: `.llmwiki/scale-downgrade/8-${plan.digest.slice(0, 12)}` };
}

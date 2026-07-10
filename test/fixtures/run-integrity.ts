/**
 * @file test/fixtures/run-integrity.ts
 * @description Shared run-record fixture helpers for the integrity-hardened store.
 *
 * `readRun` now (R3) deep-validates every field, verifies the event version chain,
 * and re-verifies a per-record HMAC. So a test that PLANTS a raw run JSON must use a
 * 64-hex digest, a valid genesis/version chain, AND stamp a valid `integrity` under
 * the project's `.runkey`. These helpers centralize that so every suite plants a
 * record `readRun` will accept (or, deliberately, reject one byte at a time).
 *
 * - {@link validDigest} — a deterministic 64-char lowercase-hex digest from a seed.
 * - {@link signRun} — stamp a valid HMAC on a run (creating the key if needed), the
 *   `writeRun`-equivalent for a raw-planted fixture.
 * - {@link plantSignedRun} — write a (signed) run JSON straight to its leaf, the raw
 *   `writeFile` path for suites exercising the read gates.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { writeRun, readRun } from "../../src/workflows/store.js";
import { loadOrCreateRunKey, runIntegrity } from "../../src/workflows/integrity.js";
import type { WorkflowRun } from "../../src/workflows/types.js";

/** A deterministic 64-char lowercase-hex digest from a short seed (a fake SHA-256). */
export function validDigest(seed: string): string {
  let hex = "";
  for (let i = 0; hex.length < 64; i++) {
    hex += seed.charCodeAt(i % Math.max(1, seed.length)).toString(16).padStart(2, "0");
  }
  return hex.slice(0, 64).toLowerCase();
}

/** Stamp a valid `integrity` HMAC on `run` under the project's run key. */
export async function signRun(root: string, run: WorkflowRun): Promise<WorkflowRun> {
  const key = await loadOrCreateRunKey(root);
  return { ...run, integrity: runIntegrity(key, run) };
}

/**
 * Assert that `run` written via `writeRun` reads back `ok` and equals its SIGNED
 * form — `writeRun` stamps `integrity`, so the read-back carries it and must match
 * the locally re-signed run. The shared round-trip assertion for the store suites.
 */
export async function expectSignedRoundTrip(root: string, run: WorkflowRun): Promise<void> {
  await writeRun(root, run);
  const result = await readRun(root, run.runId);
  expect(result.status).toBe("ok");
  if (result.status === "ok") expect(result.run).toEqual(await signRun(root, run));
}

/** The directory holding the per-run JSON files. */
export function runsDir(root: string): string {
  return path.join(root, ".llmwiki", "workflows", "runs");
}

/**
 * Plant a run record at its `<runId>.json` leaf. By default the record is SIGNED so
 * `readRun` accepts it; pass `{ sign: false }` to plant the raw (keyless) record for
 * an integrity-rejection test.
 */
export async function plantSignedRun(
  root: string,
  run: WorkflowRun,
  opts: { sign?: boolean } = {},
): Promise<void> {
  await mkdir(runsDir(root), { recursive: true });
  const record = opts.sign === false ? run : await signRun(root, run);
  await writeFile(path.join(runsDir(root), `${run.runId}.json`), JSON.stringify(record), "utf8");
}

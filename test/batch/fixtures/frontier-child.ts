/**
 * @file test/batch/fixtures/frontier-child.ts
 * @description CHILD process for the within-frontier kill witness
 * (`../frontier-kill.test.ts`); it imports no test runner, so it can be
 * bundled and run as a real process. Modes, on a prepared shared-hub project:
 * - `observe <root>`: run (or resume) the batch compile until the closure walk
 *   first reads its second queued source (`q:000000000001`, the start of the
 *   second visit, before that walk's next checkpoint), print what that
 *   attempt sees at that seam as one JSON line, and stop;
 * - `kill <root> <n>`: run the batch compile and SIGKILL THIS PROCESS at the
 *   closure's `n`-th row write (a real process death, not an exception).
 */

import { createHash } from "node:crypto";
import { BatchRun } from "../../../src/compiler/batch/run-store.js";
import { compileAndReport } from "../../../src/compiler/index.js";

/** The compile both modes run (embeddings off, which a batch compile requires; one checkpointed batch). */
const OPTIONS = { embeddings: false, batchSize: 10_000 } as const;
/** The key the closure walk reads at the start of its second visit. */
const SECOND_VISIT_KEY = "q:000000000001";

/** Stops the compile at the observed seam. */
class Observed extends Error {}

/** Count, digest and edge samples (first and last three rows) of the visible rows under `prefix`. */
async function digestOf(run: BatchRun, prefix: string): Promise<{ count: number; sha256: string; first: string[]; last: string[] }> {
  const hash = createHash("sha256");
  const first: string[] = [];
  let last: string[] = [];
  let count = 0;
  for await (const row of run.scan(prefix)) {
    const line = `${row.k}\t${JSON.stringify(row.v)}`;
    hash.update(`${line}\n`);
    if (first.length < 3) first.push(line);
    last = [...last, line].slice(-3);
    count += 1;
  }
  return { count, sha256: hash.digest("hex"), first, last };
}

/** Observe the closure at its second visit. */
async function observe(root: string): Promise<void> {
  const get = BatchRun.prototype.get;
  let seen: Record<string, unknown> | null = null;
  BatchRun.prototype.get = async function (this: BatchRun, key: string): Promise<unknown> {
    if (seen === null && this.meta.phase === "closure" && key === SECOND_VISIT_KEY) {
      seen = { affected: await digestOf(this, "a:"), queue: await digestOf(this, "q:"), visited: await digestOf(this, "v:"), attempts: this.meta.attempts.length };
      throw new Observed();
    }
    return get.call(this, key);
  };
  await compileAndReport(root, OPTIONS).catch((error: unknown) => { if (!(error instanceof Observed)) throw error; });
  console.log(JSON.stringify({ outcome: seen === null ? "not-reached" : "observed", seen }));
}

/** Kill this process at the closure's `n`-th row write. */
async function kill(root: string, n: number): Promise<void> {
  const put = BatchRun.prototype.put;
  let writes = 0;
  BatchRun.prototype.put = async function (this: BatchRun, key: string, value: unknown): Promise<void> {
    if (this.meta.phase === "closure" && ++writes === n) process.kill(process.pid, "SIGKILL");
    return put.call(this, key, value);
  };
  await compileAndReport(root, OPTIONS);
  console.log(JSON.stringify({ outcome: "completed-without-kill" }));
}

const [mode, root, n] = process.argv.slice(2);
await (mode === "observe" ? observe(root!) : kill(root!, Number(n)));

/**
 * Input admission limits for batch review: reject excessive manifests before
 * locking, bound actual file reads, and refuse special files without blocking.
 * Exercise both the direct core and the CLI action's structured failure output.
 */

import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import reviewApproveBatchCommand, { approveReviewBatch } from "../src/commands/review-approve-batch.js";
import { readReviewBatchManifest } from "../src/commands/review-batch-input.js";
import {
  parseReviewBatchManifest,
  REVIEW_BATCH_MAX_CANDIDATES,
  REVIEW_BATCH_MAX_INPUT_BYTES,
  type ReviewBatchManifest,
} from "../src/commands/review-batch-types.js";
import * as locks from "../src/utils/lock.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();
const initialExitCode = process.exitCode;
afterEach(() => { process.exitCode = initialExitCode; });

/** Make repeated IDs so the raw entry cap cannot be bypassed by deduplication. */
function manifest(count: number): ReviewBatchManifest {
  return { schemaVersion: 1, candidates: Array.from({ length: count }, () => ({ id: "same" })) };
}

it("accepts the entry ceiling and rejects even repeated IDs above it", () => {
  expect(parseReviewBatchManifest(manifest(REVIEW_BATCH_MAX_CANDIDATES)).candidates).toHaveLength(REVIEW_BATCH_MAX_CANDIDATES);
  expect(() => parseReviewBatchManifest(manifest(REVIEW_BATCH_MAX_CANDIDATES + 1))).toThrow("100 candidate entries");
});

it("enforces the entry cap on direct calls before acquiring the project lock", async () => {
  const acquire = vi.spyOn(locks, "acquireLock");
  const result = await approveReviewBatch(root.dir, manifest(REVIEW_BATCH_MAX_CANDIDATES + 1));
  expect(result).toMatchObject({ status: "failed", finalized: false, results: [] });
  expect(result.error).toContain("100 candidate entries");
  expect(acquire).not.toHaveBeenCalled();
});

it("accepts a regular manifest at the byte ceiling and rejects one extra byte", async () => {
  const file = path.join(root.dir, "approval.json");
  const content = JSON.stringify(manifest(0)).padEnd(REVIEW_BATCH_MAX_INPUT_BYTES, " ");
  await writeFile(file, content);
  expect(await readReviewBatchManifest(file)).toEqual(manifest(0));
  await writeFile(file, `${content} `);
  await expect(readReviewBatchManifest(file)).rejects.toThrow(`${REVIEW_BATCH_MAX_INPUT_BYTES} bytes`);
});

it("rejects a directory instead of reading it as a manifest", async () => {
  await expect(readReviewBatchManifest(root.dir)).rejects.toThrow("regular UTF-8 file");
});

it.skipIf(process.platform === "win32")("refuses symlink leaves and unopened FIFOs", async () => {
  const file = path.join(root.dir, "approval.json");
  const link = path.join(root.dir, "linked.json");
  const fifo = path.join(root.dir, "fifo.json");
  await writeFile(file, JSON.stringify(manifest(0)));
  await symlink(file, link);
  execFileSync("mkfifo", [fifo]);
  await expect(readReviewBatchManifest(link)).rejects.toThrow("regular UTF-8 file");
  await expect(readReviewBatchManifest(fifo)).rejects.toThrow("regular UTF-8 file");
});

it.each(["bytes", "entries"])("returns one JSON failure for excessive %s before locking", async (limit) => {
  const file = path.join(root.dir, "approval.json");
  const content = limit === "bytes"
    ? " ".repeat(REVIEW_BATCH_MAX_INPUT_BYTES + 1)
    : JSON.stringify(manifest(REVIEW_BATCH_MAX_CANDIDATES + 1));
  await writeFile(file, content);
  const acquire = vi.spyOn(locks, "acquireLock");
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  await reviewApproveBatchCommand({ input: file, json: true });
  expect(output).toHaveBeenCalledTimes(1);
  expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ status: "failed", finalized: false, results: [] });
  expect(process.exitCode).toBe(1);
  expect(acquire).not.toHaveBeenCalled();
});

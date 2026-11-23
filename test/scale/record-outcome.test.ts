/**
 * @file test/scale/record-outcome.test.ts
 * @description Outcome classification of a conditional (version 2) scale
 * record write when the atomic writer fails (R25). A post-commit failure is
 * `scale_outcome_unknown` whether or not the new record is visible; a
 * failure before publication whose re-read proves the previous record is
 * still in place propagates as the raw error.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { diskScaleRecordIo, writeScaleRecordFrom } from "../../src/scale/record.js";
import * as atomic from "../../src/utils/atomic-write.js";
import { recordIndexedTransition } from "../catalog/helpers.js";

const failure = { mode: "none" as "none" | "post-commit-published" | "post-commit-unpublished" | "before" };
// Copy the real module first: vi.mock patches it in place, so a later read (including `atomic`) would see the mock.
const real: typeof atomic = { ...atomic };
vi.mock("../../src/utils/atomic-write.js", async () => {
  return {
    ...real,
    atomicWrite: async (...args: Parameters<typeof real.atomicWrite>) => {
      if (failure.mode === "none") return real.atomicWrite(...args);
      if (failure.mode === "before") throw new Error("disk full");
      if (failure.mode === "post-commit-published") await real.atomicWrite(...args);
      throw new real.AtomicWritePostCommitError(new Error("directory fsync failed"));
    },
  };
});

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-record-outcome-")); failure.mode = "none"; });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Attempt a conditional successor write of the pending record, failing as `mode`. */
async function attempt(mode: typeof failure.mode): Promise<unknown> {
  const pending = await recordIndexedTransition(root);
  failure.mode = mode;
  const revision = pending.revision + 1;
  const successor = { ...pending, revision, pending: { ...pending.pending, revision } } as typeof pending;
  return writeScaleRecordFrom(diskScaleRecordIo(root), successor, pending).catch((error: unknown) => error);
}

describe("a failed conditional scale record write", () => {
  it.each(["post-commit-published", "post-commit-unpublished"] as const)("is an unknown outcome after a %s failure", async (mode) => {
    expect(await attempt(mode)).toMatchObject({ code: "scale_outcome_unknown" });
  });

  it("propagates the raw error when the previous record is proved still in place", async () => {
    expect(await attempt("before")).toMatchObject({ message: "disk full" });
  });
});

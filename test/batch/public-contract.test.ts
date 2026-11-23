/**
 * @file test/batch/public-contract.test.ts
 * @description Witnesses of how the batch compile meets the public compile
 * contract in this tree: an extraction with no concepts is a failure (the
 * classic rule), the options a batch run does not implement are refused
 * before any effect, and the batch-only options are refused on a project the
 * classic body compiles. No model, provider or network is involved.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { BatchCompileError } from "../../src/compiler/batch/contracts.js";
import { preflightBatch } from "../../src/compiler/batch/driver.js";
import { isFailedExtraction } from "../../src/compiler/batch/extraction-outcome.js";
import { routesToBatch } from "../../src/compiler/batch/route.js";

/** The refusal a call rejected with, or a failure of the test when it resolved. */
async function refusalOf(call: () => Promise<unknown>): Promise<BatchCompileError> {
  const outcome = await call().then(() => null, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(BatchCompileError);
  return outcome as BatchCompileError;
}

describe("the batch compile under the public compile contract", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "batch-contract-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("reads an extraction with no concepts as failed, and one with concepts as not", () => {
    expect(isFailedExtraction({ concepts: [] })).toBe(true);
    expect(isFailedExtraction({ concepts: [{ concept: "A" }] })).toBe(false);
  });

  it.each([
    [{ noPagesLimit: true }, /--no-pages-limit/u],
    [{ review: true }, /--review/u],
    [{ skipSeedPages: true }, /seed pages/u],
    [{ batchSize: 0 }, /batch size/u],
  ])("refuses the unsupported option %j before any effect", async (options, message) => {
    const refusal = await refusalOf(() => preflightBatch(root, options));
    expect(refusal.code).toBe("compile_batch_unsupported_option");
    expect(refusal.message).toMatch(message);
    expect(await readdir(root)).toEqual([]);
  });

  it.each([[{ batchSize: 10 }], [{ restart: true }]])("refuses the batch-only option %j on a project the classic body compiles", async (options) => {
    const refusal = await refusalOf(() => routesToBatch(root, options));
    expect(refusal.code).toBe("compile_batch_unsupported_option");
    expect(await readdir(root)).toEqual([]);
  });

  it("routes an ordinary project with no batch option to the classic body", async () => {
    expect(await routesToBatch(root, {})).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });
});

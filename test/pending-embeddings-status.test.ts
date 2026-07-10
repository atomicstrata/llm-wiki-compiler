/**
 * @file test/pending-embeddings-status.test.ts
 * @description Surface coverage that `collectStatus` carries the
 * `embeddings-refresh-pending` warning when the durable refresh marker is
 * non-empty, mirroring the journal-health surfacing — and that the field stays
 * ABSENT on a clean project (parity-safe). Also pins the coexistence invariant: a
 * project that is BOTH mid-incomplete-compile AND has pending embeddings carries
 * BOTH codes in the single `warnings[]` array.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { collectStatus } from "../src/status/collect.js";
import { writePendingEmbeddings } from "../src/utils/pending-embeddings.js";
import {
  PENDING_EMBEDDINGS_PENDING_CODE,
  PENDING_EMBEDDINGS_UNAVAILABLE_CODE,
} from "../src/trust/pending-embeddings-warning.js";
import { INCOMPLETE_COMPILE_CODE } from "../src/trust/journal-health-warning.js";
import { LLMWIKI_DIR, PENDING_EMBEDDINGS_FILE } from "../src/utils/constants.js";
import { plantPendingTwoTargetBatch } from "./trust/journal-fixture.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pending-embed-status-"));
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await mkdir(path.join(root, "wiki", "queries"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The warning codes the status envelope exposes (empty when the field is absent). */
async function statusCodes(): Promise<string[]> {
  return ((await collectStatus(root)).warnings ?? []).map((w) => w.code);
}

describe("collectStatus — pending embeddings surfacing", () => {
  it("omits the warnings field entirely on a clean project (parity-safe)", async () => {
    expect((await collectStatus(root)).warnings).toBeUndefined();
  });

  it("carries embeddings-refresh-pending when the marker is non-empty", async () => {
    await writePendingEmbeddings(root, [{ pageId: "concepts/a", attempts: 0 }]);
    expect(await statusCodes()).toContain(PENDING_EMBEDDINGS_PENDING_CODE);
  });

  it("carries embeddings-refresh-unavailable for an unreadable (corrupt) marker", async () => {
    await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
    await writeFile(path.join(root, PENDING_EMBEDDINGS_FILE), "{not json", "utf-8");
    expect(await statusCodes()).toContain(PENDING_EMBEDDINGS_UNAVAILABLE_CODE);
  });

  it("carries BOTH a journal warning and the pending-embeddings warning when both apply", async () => {
    await plantPendingTwoTargetBatch(root, "wiki/concepts", "pending");
    await writePendingEmbeddings(root, [{ pageId: "concepts/a", attempts: 0 }]);
    const codes = await statusCodes();
    expect(codes).toContain(INCOMPLETE_COMPILE_CODE);
    expect(codes).toContain(PENDING_EMBEDDINGS_PENDING_CODE);
  });
});

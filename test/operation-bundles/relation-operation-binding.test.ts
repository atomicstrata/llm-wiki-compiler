/**
 * @file test/operation-bundles/relation-operation-binding.test.ts
 * @description Task 2 tests for the operation-aware relation append. A created
 * record and its child event persist the exact binding and raise the header to
 * v2; an exact retry appends nothing; a divergent mutation-id parks; and an exact
 * pre-existing relation is applied without a duplicate record.
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RELATIONS_FILE } from "../../src/utils/constants.js";
import type { OperationBinding } from "../../src/utils/operation-binding.js";
import { mintBundleId, mintOperationRunId, mutationId } from "../../src/operation-bundles/ids.js";
import { appendLine, appendRelation, buildRelationRef, compactRelations } from "../../src/relations/store.js";
import { appendRelationForOperationLocked } from "../../src/relations/operation-write.js";
import { ensureRelationOperationVersionLocked } from "../../src/relations/store-version.js";
import { readRelationRecords } from "../../src/relations/store-read.js";
import { readEvents } from "../../src/events/store-read.js";
import type { EntityId } from "../../src/profile/types.js";
import { relatedProfile as profile, RELATED_INPUT as input } from "../fixtures/profile-fixtures.js";

function makeBinding(): OperationBinding {
  const bundleId = mintBundleId();
  return { bundleId, runId: mintOperationRunId(), mutationId: mutationId(bundleId, 0) };
}

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "rel-op-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function headerVersion(): Promise<number> {
  const raw = await readFile(path.join(root, RELATIONS_FILE), "utf8");
  return JSON.parse(raw.split("\n")[0]!).schemaVersion;
}

describe("appendRelationForOperationLocked", () => {
  it("refuses legacy compaction without changing bound history or retry ownership", async () => {
    const binding = makeBinding();
    await appendRelationForOperationLocked(root, profile(), input, binding);
    const before = await readFile(path.join(root, RELATIONS_FILE));
    await expect(compactRelations(root, profile())).rejects.toThrow(/operation-bound history/);
    expect(await readFile(path.join(root, RELATIONS_FILE))).toEqual(before);
    expect(await headerVersion()).toBe(2);
    expect(await appendRelationForOperationLocked(root, profile(), input, binding))
      .toMatchObject({ status: "skipped-idempotent", bound: true });
  });

  it("stamps the binding on a created record and its child event at header v2", async () => {
    const binding = makeBinding();
    const result = await appendRelationForOperationLocked(root, profile(), input, binding);
    expect(result.status).toBe("created");
    const { records } = await readRelationRecords(root);
    expect(records).toHaveLength(1);
    expect(records[0]!.operationBinding).toEqual(binding);
    const bound = (await readEvents(root)).events.filter((event) => event.operationBinding !== undefined);
    expect(bound.map((event) => event.type)).toEqual(["relation-create"]);
    expect(bound[0]!.operationBinding).toEqual(binding);
    expect(await headerVersion()).toBe(2);
  });

  it("appends nothing on an exact retry", async () => {
    const binding = makeBinding();
    await appendRelationForOperationLocked(root, profile(), input, binding);
    const retry = await appendRelationForOperationLocked(root, profile(), input, binding);
    expect(retry.status).toBe("skipped-idempotent");
    expect((await readRelationRecords(root)).records).toHaveLength(1);
  });

  it("parks a divergent mutation on the same binding", async () => {
    const binding = makeBinding();
    await appendRelationForOperationLocked(root, profile(), input, binding);
    const divergent = { type: "related", from: "experiments/x" as EntityId, to: "ideas/y" as EntityId };
    const result = await appendRelationForOperationLocked(root, profile(), divergent, binding);
    expect(result.status).toBe("conflict");
  });

  it("forward-repairs a missing child event when the bound record already exists", async () => {
    const binding = makeBinding();
    // Simulate a crash between the relation authority record and its child event:
    // the bound record exists on disk, but no operation-bound event was emitted.
    await ensureRelationOperationVersionLocked(root);
    await appendLine(root, buildRelationRef(profile(), input), binding);
    expect((await readEvents(root)).events.filter((event) => event.operationBinding !== undefined)).toHaveLength(0);
    const result = await appendRelationForOperationLocked(root, profile(), input, binding);
    // The record is bound to this mutation, so the skip is bound (recovery -> applied).
    expect(result).toMatchObject({ status: "skipped-idempotent", bound: true });
    const bound = (await readEvents(root)).events.filter((event) => event.operationBinding?.mutationId === binding.mutationId);
    expect(bound).toHaveLength(1);
  });

  it("applies an exact pre-existing relation without a duplicate record", async () => {
    await appendRelation(root, profile(), input); // ordinary create, no binding
    const binding = makeBinding();
    const result = await appendRelationForOperationLocked(root, profile(), input, binding);
    // A pre-existing relation deduped by content: this run did not produce it (unbound).
    expect(result).toMatchObject({ status: "skipped-idempotent", bound: false });
    const related = (await readRelationRecords(root)).records.filter((record) => record.ref.type === "related");
    expect(related).toHaveLength(1);
    expect(related[0]!.operationBinding).toBeUndefined();
    expect((await readEvents(root)).events.filter((event) => event.operationBinding !== undefined)).toHaveLength(1);
  });
});

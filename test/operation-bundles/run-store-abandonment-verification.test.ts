/**
 * @file test/operation-bundles/run-store-abandonment-verification.test.ts
 * @description Filesystem-level abandonment proofs for exact manifest binding,
 * manifest-derived namespaces, exact unresolved observations, and handle-bound
 * run-evidence verification before a signed terminal write.
 */

import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_MUTATIONS_PER_BUNDLE, MAX_RUN_EVIDENCE_BLOB_BYTES } from "../../src/operation-bundles/constants.js";
import { mutationId } from "../../src/operation-bundles/ids.js";
import { createOperationKeyForEmptyEpochLocked, type OperationEpochInventory } from "../../src/operation-bundles/key-epoch.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import type { OperationPrincipal } from "../../src/operation-bundles/principal.js";
import { operationRunPredecessor } from "../../src/operation-bundles/run-integrity.js";
import { appendAbandonedTransitionLocked, appendControlTransition, createOperationRunLocked } from "../../src/operation-bundles/run-store.js";
import type { RunEvidenceRef } from "../../src/operation-bundles/run-types.js";
import type { OperationDigest } from "../../src/operation-bundles/types.js";
import { runFixture } from "./run-fixture.js";

/** Return one healthy empty inventory partition for key-epoch setup. */
const healthyInventoryEntry = () => ({ count: 0, bytes: 0, health: "ok" as const });
const INVENTORY: OperationEpochInventory = {
  bundles: healthyInventoryEntry(), runs: healthyInventoryEntry(), payloads: healthyInventoryEntry(),
  evidence: healthyInventoryEntry(), cancelRequests: healthyInventoryEntry(), orphans: healthyInventoryEntry(),
};
const AT = "2026-07-18T02:00:00.000Z";
const ACTOR: OperationPrincipal = { id: "operator", surface: "cli", grants: ["operation-bundle.abandon"] };
let root: string;

beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "run-abandon-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Create and park one exact run with one unresolved retained-source mutation. */
async function parkedFixture() {
  const key = await createOperationKeyForEmptyEpochLocked(root, INVENTORY);
  const fixture = runFixture({ key: key.key, actor: ACTOR, at: AT, authoritativeMutationCount: 1 });
  let run = await createOperationRunLocked(root, fixture.input);
  run = await appendControlTransition(root, fixture.binding, operationRunPredecessor(run), {
    type: "recovery-required", code: "run-record-headroom-exhausted", actor: ACTOR, at: AT,
  });
  return { ...fixture, run, paths: operationPaths(root, fixture.binding.workspaceId) };
}

/** Return an evidence reference whose leaf name and bytes are cryptographically bound. */
function evidence(body: Buffer): RunEvidenceRef {
  const digest = `sha256:${createHash("sha256").update(body).digest("hex")}` as OperationDigest;
  return { digest, byteCount: body.byteLength, type: "observation", provenance: "controller" };
}

/** Publish one test evidence leaf at its digest-derived run-owned path. */
async function writeEvidence(fixture: Awaited<ReturnType<typeof parkedFixture>>, ref: RunEvidenceRef, body: Buffer): Promise<string> {
  await mkdir(fixture.paths.evidenceRoot(fixture.runId), { recursive: true });
  const file = fixture.paths.evidenceFile(fixture.runId, ref.digest.slice("sha256:".length));
  await writeFile(file, body);
  return file;
}

/** Build the observation DTO that deliberately has no namespace field. */
function observation(fixture: Awaited<ReturnType<typeof parkedFixture>>, ref: RunEvidenceRef) {
  return { code: "residual", mutationId: mutationId(fixture.bundleId, 0), evidence: ref };
}

/** Invoke the evidence-verifying abandonment writer with overridable input. */
function abandon(fixture: Awaited<ReturnType<typeof parkedFixture>>, observations: readonly ReturnType<typeof observation>[], manifest = fixture.manifest, actor = ACTOR) {
  return appendAbandonedTransitionLocked(root, fixture.binding, operationRunPredecessor(fixture.run), {
    actor, at: AT, confirmResidualState: true, manifest, observations,
  });
}

/** Return an array whose iteration proves a rejected input was traversed. */
function throwingObservations(length: number): readonly ReturnType<typeof observation>[] {
  return new Proxy(new Array<ReturnType<typeof observation>>(length), {
    get(target, property, receiver) {
      if (property === Symbol.iterator) throw new Error("abandonment observations were traversed");
      return Reflect.get(target, property, receiver);
    },
  }) as readonly ReturnType<typeof observation>[];
}

describe("abandonment store verification", () => {
  it("rejects a manifest that is not the exact run binding", async () => {
    const fixture = await parkedFixture(), body = Buffer.from("evidence");
    const ref = evidence(body);
    await writeEvidence(fixture, ref, body);
    const wrong = { ...fixture.manifest, createdBy: "other" };
    await expect(abandon(fixture, [observation(fixture, ref)], wrong)).rejects.toThrow(/manifest.*binding|digest/i);
  });

  it("rejects absent, mismatched, and unavailable run-evidence leaves", async () => {
    const fixture = await parkedFixture(), body = Buffer.from("evidence"), ref = evidence(body);
    const item = observation(fixture, ref);
    await expect(abandon(fixture, [item])).rejects.toThrow(/evidence.*absent|evidence.*present/i);
    const file = await writeEvidence(fixture, ref, Buffer.from("mismatch"));
    await expect(abandon(fixture, [item])).rejects.toThrow(/evidence.*digest|evidence.*byte/i);
    await writeFile(file, body);
    await expect(abandon(fixture, [{ ...item, evidence: { ...ref, byteCount: ref.byteCount + 1 } }])).rejects.toThrow(/evidence.*byte/i);
    await rm(file);
    await symlink(path.join(root, "outside-evidence"), file);
    await expect(abandon(fixture, [item])).rejects.toThrow(/evidence.*unavailable/i);
  });

  it("caps the opened evidence leaf before hashing it", async () => {
    const fixture = await parkedFixture(), body = Buffer.alloc(MAX_RUN_EVIDENCE_BLOB_BYTES + 1, 1);
    const ref = evidence(body);
    await writeEvidence(fixture, ref, body);
    const capped = { ...ref, byteCount: MAX_RUN_EVIDENCE_BLOB_BYTES };
    await expect(abandon(fixture, [observation(fixture, capped)])).rejects.toThrow(/evidence.*unavailable/i);
  });

  it("refuses evidence whose inode has an external alias", async () => {
    const fixture = await parkedFixture(), body = Buffer.from("aliased evidence");
    const ref = evidence(body), file = await writeEvidence(fixture, ref, body);
    await link(file, path.join(root, "external-evidence-alias"));

    await expect(abandon(fixture, [observation(fixture, ref)]))
      .rejects.toThrow(/evidence.*unavailable/i);
  });

  it("derives namespaces and signs only exact verified evidence", async () => {
    const fixture = await parkedFixture(), body = Buffer.from([0, 255, 1, 2]);
    const ref = evidence(body);
    await writeEvidence(fixture, ref, body);
    const abandoned = await abandon(fixture, [observation(fixture, ref)]);
    expect(abandoned.residualFindings).toEqual([{
      code: "residual", mutationId: mutationId(fixture.bundleId, 0),
      authoritativeNamespace: "workspace-sources", evidence: ref,
    }]);
  });

  it("refuses caller-supplied authoritative namespaces", async () => {
    const fixture = await parkedFixture(), body = Buffer.from("evidence"), ref = evidence(body);
    await writeEvidence(fixture, ref, body);
    const supplied = { ...observation(fixture, ref), authoritativeNamespace: "wiki" };
    await expect(abandon(fixture, [supplied])).rejects.toThrow(/namespace.*caller|observation.*field/i);
  });

  it("rejects a one-MiB observation code before evidence I/O", async () => {
    const fixture = await parkedFixture(), ref = evidence(Buffer.from("absent"));
    const oversized = { ...observation(fixture, ref), code: "x".repeat(1024 * 1024) };
    await expect(abandon(fixture, [oversized])).rejects.toThrow(/residual code.*bounded string/i);
  });

  it.each(["type", "provenance"] as const)("rejects oversized evidence %s before evidence I/O", async (field) => {
    const fixture = await parkedFixture(), ref = evidence(Buffer.from("absent"));
    const malformed = { ...observation(fixture, ref), evidence: { ...ref, [field]: "x".repeat(129) } };
    await expect(abandon(fixture, [malformed])).rejects.toThrow(/evidence (type|provenance).*bounded string/i);
  });

  it.each([-1, MAX_RUN_EVIDENCE_BLOB_BYTES + 1])("rejects evidence byteCount %i before evidence I/O", async (byteCount) => {
    const fixture = await parkedFixture(), ref = evidence(Buffer.from("absent"));
    const malformed = { ...observation(fixture, ref), evidence: { ...ref, byteCount } };
    await expect(abandon(fixture, [malformed])).rejects.toThrow(/nonnegative safe integer|evidence reference exceeds blob cap/i);
  });

  it("rejects unknown nested evidence fields before evidence I/O", async () => {
    const fixture = await parkedFixture(), ref = evidence(Buffer.from("absent"));
    const malformed = { ...observation(fixture, ref), evidence: { ...ref, surprise: true } };
    await expect(abandon(fixture, [malformed])).rejects.toThrow(/unknown field surprise/i);
  });

  it("rejects an ungranted actor before run or observation work", async () => {
    const fixture = await parkedFixture();
    await rm(fixture.paths.runFile(fixture.runId));
    const actor: OperationPrincipal = { ...ACTOR, grants: [] };
    await expect(abandon(fixture, throwingObservations(1), fixture.manifest, actor))
      .rejects.toThrow(/operation-bundle\.abandon.*grant|abandon.*grant/i);
  });

  it("rejects oversized observations before traversal", async () => {
    const fixture = await parkedFixture();
    await expect(abandon(fixture, throwingObservations(MAX_MUTATIONS_PER_BUNDLE + 1)))
      .rejects.toThrow(/observation.*launch bound|observation.*256|too many/i);
  });

  it("rejects unresolved-count mismatch before traversal", async () => {
    const fixture = await parkedFixture();
    await expect(abandon(fixture, throwingObservations(0)))
      .rejects.toThrow(/exactly cover|observation.*count/i);
  });
});

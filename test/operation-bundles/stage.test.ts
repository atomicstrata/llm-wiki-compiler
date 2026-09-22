/**
 * @file test/operation-bundles/stage.test.ts
 * @description End-to-end staging preflight tests for byte-identical dry-run,
 * exact payload-manifest-run creation, and deterministic zero-write refusals.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readCandidate } from "../../src/compiler/candidates.js";
import { CANDIDATES_DIR } from "../../src/utils/constants.js";
import { listProjectFiles } from "../fixtures/project-files.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { readOperationKey } from "../../src/operation-bundles/key-epoch.js";
import { readOperationManifest } from "../../src/operation-bundles/manifest-store.js";
import { readOperationRun } from "../../src/operation-bundles/run-store.js";
import {
  assertReviewIdentityAvailable,
  stageOperationBundleLocked,
  type OperationBundleDraft,
  type StageOperationBundleRequest,
} from "../../src/operation-bundles/stage.js";
import type { BundleId } from "../../src/operation-bundles/ids.js";
import type { OperationRunId } from "../../src/operation-bundles/ids.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import { scanOperationInventory } from "../../src/operation-bundles/capacity.js";
import {
  MAX_CATALOG_RECORD_BYTES, MAX_PROJECTION_BYTES,
} from "../../src/operation-bundles/constants.js";

const root = useTempRoot();
const DIGEST = `sha256:${"a".repeat(64)}` as const;
const AT = "2026-07-18T12:00:00.000Z";
const AUTHORITY = {
  knowledgeAuthority: { id: "knowledge", digest: DIGEST },
  operationsAuthority: {
    packId: "pack", packDigest: DIGEST, actionId: "prepare",
    actionDescriptorDigest: DIGEST,
  },
  grantDigest: DIGEST,
  safetyFloorDigest: DIGEST,
};
const EMPTY_COMPLETENESS = {
  attempted: 0, completed: 0, skipped: 0, failed: 0,
  requiredMissing: 0, optionalMissing: 0, rationaleDigest: DIGEST,
};

/** Return the raw lowercase SHA-256 name for payload bytes. */
function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Build one source-retain draft whose identities are derived during staging. */
function sourceMutation(bytes: Buffer) {
  const payloadRef = digest(bytes), bound = `sha256:${payloadRef}` as const;
  return {
    kind: "source-retain" as const, operation: "create" as const,
    target: { digest: payloadRef }, payloadRef, dependsOn: [], reconciliationRefs: [],
    precondition: { kind: "absent-or-same" as const, digest: bound, byteCount: bytes.length },
    postcondition: { digest: bound, byteCount: bytes.length },
  };
}

/** Build one page draft with an explicitly supplied postcondition digest. */
function pageMutation(bytes: Buffer, postconditionDigest = `sha256:${digest(bytes)}` as const) {
  return {
    kind: "page" as const, operation: "create" as const,
    target: { kind: "entity" as const, entityType: "concept", slug: "page" },
    payloadRef: digest(bytes), dependsOn: [], reconciliationRefs: [],
    precondition: { kind: "absent" as const },
    postcondition: { digest: postconditionDigest, byteCount: bytes.length },
  };
}

/** Build one projection draft without introducing executable behavior. */
function projectionMutation(output = "brief.md") {
  return {
    kind: "projection" as const, operation: "render" as const,
    target: { recipeId: "daily-brief", recipeDigest: DIGEST,
      output, criticality: "required" as const },
    dependsOn: [], reconciliationRefs: [], precondition: { kind: "absent" as const },
    postcondition: { digest: DIGEST },
  };
}

/** Build one catalog-record draft from canonical JSON payload bytes. */
function catalogMutation(bytes: Buffer) {
  return {
    kind: "catalog-record" as const, operation: "create" as const,
    target: { logicalRecordId: "source-1" }, payloadRef: digest(bytes),
    dependsOn: [], reconciliationRefs: [], precondition: { kind: "absent" as const },
    postcondition: { digest: `sha256:${digest(bytes)}` as const },
  };
}

/** Build the minimal internal draft plus genesis authority. */
function draft(bytes: Buffer, mutationCount = 1): OperationBundleDraft {
  return {
    workspaceId: "research", createdBy: "planner", ...AUTHORITY,
    inputs: [], preparationEvidence: [], bounds: [], completeness: EMPTY_COMPLETENESS,
    reconciliations: [], planningWarnings: [],
    mutations: Array.from({ length: mutationCount }, () => sourceMutation(bytes)),
    run: {
      actor: { id: "planner", surface: "sdk", grants: [] },
      declaredCompensatorIndexes: [], controlTransitionAllowance: 32,
    },
  };
}

/** Build one deterministic request around a payload. */
function request(bytes = Buffer.from("payload")): StageOperationBundleRequest {
  return {
    draft: draft(bytes), payloads: new Map([[digest(bytes), bytes]]),
    clock: { now: () => new Date(AT) },
  };
}

/** Snapshot every private file as exact base64 bytes. */
async function privateSnapshot(): Promise<Record<string, string>> {
  const files = (await listProjectFiles(root.dir)).filter((file) => file.startsWith(".llmwiki/"));
  const entries = await Promise.all(files.map(async (file) =>
    [file, (await readFile(path.join(root.dir, file))).toString("base64")] as const));
  return Object.fromEntries(entries);
}

/** Prove one rejected request leaves all private state byte-identical. */
async function expectRefusalWithoutWrites(
  staged: StageOperationBundleRequest,
  message: RegExp,
): Promise<void> {
  const before = await privateSnapshot();
  await expect(stageOperationBundleLocked(root.dir, staged)).rejects.toThrow(message);
  expect(await privateSnapshot()).toEqual(before);
  expect(await readOperationKey(root.dir)).toEqual({ status: "absent" });
}

/** Plant one readable legacy candidate under an operation-bundle identity. */
async function plantLegacyCandidate(id: string): Promise<void> {
  const dir = path.join(root.dir, CANDIDATES_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify({
    id, title: "Legacy", slug: "legacy", summary: "", sources: [], body: "body",
    generatedAt: AT, reviewMode: "forced",
    heldReasons: [{ code: "manual-review-requested" }],
  }));
}

describe("operation bundle staging", () => {
  it("returns canonical intent and exact run budget from a byte-identical dry-run", async () => {
    const before = await privateSnapshot();

    const result = await stageOperationBundleLocked(root.dir, { ...request(), dryRun: true });

    expect(result).toMatchObject({ wrote: false, manifest: { createdAt: AT, workspaceId: "research" } });
    expect(result.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.projectedRunBudget.projectedTransitionCount).toBeGreaterThan(0);
    expect(await privateSnapshot()).toEqual(before);
    expect(await readOperationKey(root.dir)).toEqual({ status: "absent" });
  });

  it("durably creates payload then manifest then a bound HMAC genesis run", async () => {
    const result = await stageOperationBundleLocked(root.dir, request());
    expect(result.wrote).toBe(true);

    const stored = await readOperationManifest(root.dir, "research", result.manifest.bundleId);
    expect(stored).toEqual({ status: "ok", manifest: result.manifest });
    const key = await readOperationKey(root.dir);
    expect(key.status).toBe("ok");
    if (key.status !== "ok") return;
    const binding = {
      bundleId: result.manifest.bundleId, runId: result.manifest.runId,
      workspaceId: result.manifest.workspaceId, manifestDigest: result.manifestDigest,
      keyEpochId: key.keyEpochId,
    };
    await expect(readOperationRun(root.dir, binding)).resolves.toMatchObject({
      status: "ok", run: { state: "awaiting-approval", schemaVersion: 1, ...binding },
    });
  });

  it("rejects payload digest mismatch without a key or partial staging, then succeeds", async () => {
    const good = request(), bad = Buffer.from("tampered");
    const malformed = { ...good, payloads: new Map([[digest(Buffer.from("payload")), bad]]) };

    await expectRefusalWithoutWrites(malformed, /payload.*digest/i);
    await expect(stageOperationBundleLocked(root.dir, good)).resolves.toMatchObject({ wrote: true });
  });

  it("rejects mutation-count and run-budget exhaustion before the first write", async () => {
    const bytes = Buffer.from("bounded"), before = await privateSnapshot();
    const tooMany = { ...request(bytes), draft: draft(bytes, 257) };
    await expect(stageOperationBundleLocked(root.dir, tooMany)).rejects.toThrow(/mutation.*cap/i);
    expect(await privateSnapshot()).toEqual(before);

    const budgetDraft = draft(bytes, 256);
    budgetDraft.run.declaredCompensatorIndexes = Array.from({ length: 256 }, (_, index) => index);
    budgetDraft.run.controlTransitionAllowance = 256;
    await expect(stageOperationBundleLocked(root.dir, { ...request(bytes), draft: budgetDraft }))
      .rejects.toThrow(/run|transition|headroom/i);
    expect(await privateSnapshot()).toEqual(before);
    await expect(stageOperationBundleLocked(root.dir, request(bytes))).resolves.toMatchObject({ wrote: true });
  });

  it("counts one content-addressed retained source once across repeated mutations", async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
    const repeated = { ...request(bytes), draft: draft(bytes, 256) };

    const result = await stageOperationBundleLocked(root.dir, repeated);

    expect(result).toMatchObject({ wrote: true, manifest: { mutations: { length: 256 } } });
  });

  it("validates the exact genesis shape before creating a key or bundle bytes", async () => {
    const bytes = Buffer.from("genesis"), malformed = draft(bytes);
    malformed.run.actor = { ...malformed.run.actor, id: "x".repeat(129) };

    await expectRefusalWithoutWrites({ ...request(bytes), draft: malformed }, /principal|actor/i);
    await expect(stageOperationBundleLocked(root.dir, request(bytes)))
      .resolves.toMatchObject({ wrote: true });
  });

  it("binds retained preparation-evidence digests before the first write", async () => {
    const bytes = Buffer.from("evidence"), malformed = draft(bytes);
    malformed.preparationEvidence = [{
      type: "planner", provenance: "adapter", digest: DIGEST,
      byteCount: bytes.length, payloadRef: digest(bytes),
    }];
    await expectRefusalWithoutWrites(
      { ...request(bytes), draft: malformed },
      /evidence.*digest|payload.*digest/i,
    );
  });

  it("rejects page bytes that do not equal the declared postcondition digest", async () => {
    const bytes = Buffer.from("page bytes"), malformed = draft(bytes);
    malformed.mutations = [pageMutation(bytes, DIGEST)];

    await expectRefusalWithoutWrites(
      { ...request(bytes), draft: malformed }, /page.*postcondition|postcondition.*digest/i,
    );
  });

  it("treats preparation evidence as a normal bundle payload above the run-evidence blob cap", async () => {
    const bytes = Buffer.alloc(300 * 1024, 0x61), prepared = draft(bytes);
    const payloadRef = digest(bytes);
    prepared.preparationEvidence = [{
      type: "planner", provenance: "adapter", digest: `sha256:${payloadRef}`,
      byteCount: bytes.length, payloadRef,
    }];

    await expect(stageOperationBundleLocked(root.dir, { ...request(bytes), draft: prepared }))
      .resolves.toMatchObject({ wrote: true });
  });

  it("rejects a declared compensator that names a projection mutation", async () => {
    const bytes = Buffer.from("page"), malformed = draft(bytes);
    malformed.mutations = [pageMutation(bytes), projectionMutation()];
    malformed.bounds = [{ name: "projection-1-bytes", unit: "bytes", maximum: 1024 }];
    malformed.run.declaredCompensatorIndexes = [1];

    await expectRefusalWithoutWrites(
      { ...request(bytes), draft: malformed }, /compensator.*(?:projection|authoritative)|compensatable/i,
    );
  });

  it.each([
    ["missing", [], /projection.*bound/i],
    ["extra", [
      { name: "projection-1-bytes", unit: "bytes" as const, maximum: 1024 },
      { name: "projection-2-bytes", unit: "bytes" as const, maximum: 1024 },
    ], /projection.*bound/i],
    ["oversize", [
      { name: "projection-1-bytes", unit: "bytes" as const, maximum: MAX_PROJECTION_BYTES + 1 },
    ], /projection|bound/i],
  ])("rejects %s projection bounds before writing", async (_case, bounds, message) => {
    const bytes = Buffer.from("page"), malformed = draft(bytes);
    malformed.mutations = [pageMutation(bytes), projectionMutation()];
    malformed.bounds = bounds;

    await expectRefusalWithoutWrites({ ...request(bytes), draft: malformed }, message);
  });

  it("projects every declared projection maximum into the workspace aggregate cap", async () => {
    const bytes = Buffer.from("page"), malformed = draft(bytes);
    const projections = Array.from({ length: 17 }, (_, index) => projectionMutation(`brief-${index}.md`));
    malformed.mutations = [pageMutation(bytes), ...projections];
    malformed.bounds = projections.map((_, index) => ({
      name: `projection-${index + 1}-bytes`, unit: "bytes" as const,
      maximum: MAX_PROJECTION_BYTES,
    }));

    await expectRefusalWithoutWrites(
      { ...request(bytes), draft: malformed }, /workspace-projections.*cap/i,
    );
  });

  it("preflights the canonical catalog record rather than trusting payload bytes alone", async () => {
    const bytes = Buffer.from(JSON.stringify({
      body: "x".repeat(MAX_CATALOG_RECORD_BYTES - 300),
    }));
    const malformed = draft(bytes);
    malformed.mutations = [catalogMutation(bytes)];

    await expectRefusalWithoutWrites(
      { ...request(bytes), draft: malformed }, /catalog.*record.*cap/i,
    );
  });

  it("refuses a readable legacy candidate collision without changing its bytes", async () => {
    const bundleId = "bnd_01J00000000000000000000000" as BundleId;
    await plantLegacyCandidate(bundleId);
    const before = await privateSnapshot();

    await expect(assertReviewIdentityAvailable(root.dir, bundleId)).rejects.toThrow(/ambiguous/i);

    expect(await privateSnapshot()).toEqual(before);
    await expect(readCandidate(root.dir, bundleId)).resolves.toMatchObject({ id: bundleId });
  });

  it("refuses a malformed but readable legacy candidate identity", async () => {
    const bundleId = "bnd_01J00000000000000000000004" as BundleId;
    const dir = path.join(root.dir, CANDIDATES_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${bundleId}.json`), "{");
    const before = await privateSnapshot();

    await expect(assertReviewIdentityAvailable(root.dir, bundleId))
      .rejects.toThrow(/ambiguous|custody/i);

    expect(await privateSnapshot()).toEqual(before);
  });

  it("accepts an exact fully staged replay without colliding at run creation", async () => {
    const ids = {
      bundleId: "bnd_01J00000000000000000000002" as BundleId,
      runId: "opr_01J00000000000000000000002" as OperationRunId,
    };
    const fixed = { ...request(Buffer.from("replay")), idsForTest: ids };
    const first = await stageOperationBundleLocked(root.dir, fixed);
    const before = await privateSnapshot();

    const replay = await stageOperationBundleLocked(root.dir, fixed);

    expect(replay).toEqual({ ...first, wrote: false });
    expect(await privateSnapshot()).toEqual(before);
  });

  it("rejects an existing bundle identity conflict before adding payload bytes", async () => {
    const ids = {
      bundleId: "bnd_01J00000000000000000000003" as BundleId,
      runId: "opr_01J00000000000000000000003" as OperationRunId,
    };
    await stageOperationBundleLocked(root.dir, { ...request(Buffer.from("first")), idsForTest: ids });
    const before = await privateSnapshot();
    const conflicting = { ...request(Buffer.from("second")), idsForTest: ids };

    await expect(stageOperationBundleLocked(root.dir, conflicting)).rejects.toThrow(/bundle.*conflict/i);

    expect(await privateSnapshot()).toEqual(before);
  });

  it("fails closed when a prior manifest-bound payload has changed", async () => {
    const staged = await stageOperationBundleLocked(root.dir, request(Buffer.from("trusted")));
    const mutation = staged.manifest.mutations[0]!;
    if (!("payloadRef" in mutation)) throw new Error("fixture requires payload mutation");
    const paths = operationPaths(root.dir, staged.manifest.workspaceId);
    await writeFile(paths.payloadFile(staged.manifest.bundleId, mutation.payloadRef), "changed");

    const inventory = await scanOperationInventory(root.dir);

    expect(inventory.problems.map((item) => item.dimension)).toContain("payload-state");
    await expect(stageOperationBundleLocked(root.dir, request())).rejects.toThrow(/inventory unavailable/i);
  });
});

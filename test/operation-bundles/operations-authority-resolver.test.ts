/**
 * @file test/operation-bundles/operations-authority-resolver.test.ts
 * @description Core contract tests for the production operations-authority
 * resolver: it recomputes an ok snapshot from authoritative state, is byte-
 * deterministic over identical state (the recovery precondition), ignores every
 * caller-supplied component digest, and stamps the host-owned not-configured
 * constants for the unpopulated Milestone-A policy subsystems.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { createOperationsAuthorityResolver } from "../../src/operation-bundles/operations-authority-resolver.js";
import { OPERATION_MUTATION_KINDS } from "../../src/operation-bundles/adapter-registry.js";
import { OPERATION_AUTHORITY_COMPONENTS, type OperationAuthoritySnapshot } from "../../src/operation-bundles/authority.js";
import { operationManifestDigest } from "../../src/operation-bundles/manifest-parse.js";
import { canonicalDigest } from "../../src/profile/templates/signing/canonical.js";
import { authorityRequestFor, stageSourceBundle } from "./executor-fixtures.js";

const resolver = createOperationsAuthorityResolver({ adapterKinds: OPERATION_MUTATION_KINDS });
const DIGEST_SHAPE = /^sha256:[0-9a-f]{64}$/;

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-auth-resolver-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** Stage a source bundle and return its recomputed ok snapshot (asserting ok). */
async function okSnapshotFor(): Promise<OperationAuthoritySnapshot> {
  const staged = await stageSourceBundle(root);
  const result = await resolver.computeSnapshot(await authorityRequestFor(root, staged));
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error(result.reason);
  return result.snapshot;
}

describe("createOperationsAuthorityResolver — ok snapshot", () => {
  it("recomputes an ok snapshot with all twelve sha256-shaped components", async () => {
    const snapshot = await okSnapshotFor();
    for (const component of OPERATION_AUTHORITY_COMPONENTS) {
      expect(snapshot[component]).toMatch(DIGEST_SHAPE);
    }
  });

  it("recomputes manifestDigest from the store manifest, not request.manifestDigest", async () => {
    const staged = await stageSourceBundle(root);
    const request = await authorityRequestFor(root, staged);
    const bogus = { ...request, manifestDigest: `sha256:${"e".repeat(64)}` as const };
    const result = await resolver.computeSnapshot(bogus);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.snapshot.manifestDigest).toBe(operationManifestDigest(request.manifest));
  });
});

describe("createOperationsAuthorityResolver — determinism", () => {
  it("produces a byte-identical digest across two calls over identical state", async () => {
    const staged = await stageSourceBundle(root);
    const first = await resolver.computeSnapshot(await authorityRequestFor(root, staged));
    const second = await resolver.computeSnapshot(await authorityRequestFor(root, staged));
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status !== "ok" || second.status !== "ok") return;
    expect(second.digest).toBe(first.digest);
    expect(second.snapshot).toEqual(first.snapshot);
  });
});

describe("createOperationsAuthorityResolver — ignores caller digests", () => {
  it("recomputes an identical digest whether the request copies are correct or bogus", async () => {
    const staged = await stageSourceBundle(root);
    const good = await resolver.computeSnapshot(await authorityRequestFor(root, staged));
    const request = await authorityRequestFor(root, staged);
    const bogus = { ...request, manifestDigest: `sha256:${"a".repeat(64)}` as const,
      adapterCapabilityDigest: `sha256:${"b".repeat(64)}` as const, keyEpochId: `sha256:${"c".repeat(64)}` as const };
    const result = await resolver.computeSnapshot(bogus);
    expect(good.status === "ok" && result.status === "ok" && result.digest === good.digest).toBe(true);
  });
});

describe("createOperationsAuthorityResolver — not-configured constants", () => {
  it("stamps fixed domain-separated constants that ignore the manifest policy refs", async () => {
    const snapshot = await okSnapshotFor();
    expect(snapshot.operationsAuthorityDigest).toBe(canonicalDigest({ component: "operationsAuthority", configured: false }));
    expect(snapshot.actionDescriptorDigest).toBe(canonicalDigest({ component: "actionDescriptor", configured: false }));
    expect(snapshot.safetyFloorDigest).toBe(canonicalDigest({ component: "safetyFloor", configured: false }));
  });
});

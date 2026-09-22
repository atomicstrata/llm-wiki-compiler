/**
 * @file test/operation-bundles/artifact-adapter.test.ts
 * @description Task 3 five-way observation tests for the artifact adapter, which
 * compares the on-disk body, its manifest, and the bound audit event against the
 * manifest postcondition digest.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { artifactAdapter } from "../../src/operation-bundles/adapters/artifact.js";
import { appendBoundEventLocked } from "../../src/events/store.js";
import { artifactPaths, hashArtifactBody, writeArtifactFiles, type ArtifactManifest } from "../../src/artifacts/store.js";
import { writeProfileFile } from "../fixtures/profile-fixtures.js";
import type { ProfilePack } from "../../src/profile/types.js";
import type { ArtifactOperationMutation } from "../../src/operation-bundles/types.js";
import { digestOf, makeBinding, makeContext, publishPayload, type BindingSet } from "./adapter-fixtures.js";

const PROFILE: ProfilePack = {
  schemaVersion: 1, profileId: "research", entities: { note: { directory: "wiki/note" } },
  artifacts: { note: { fileName: "note.txt", contentKind: "text", maxBytes: 65_536 } },
};

const BODY = "note contents\n";
const TYPE = "note";
const SLUG = "a";

function artifactMutation(set: BindingSet): ArtifactOperationMutation {
  return {
    kind: "artifact", index: 0, mutationId: set.onDisk.mutationId, dependsOn: [], reconciliationRefs: [],
    operation: "create", target: { artifactType: TYPE, logicalId: SLUG }, payloadRef: hashArtifactBody(BODY),
    precondition: { kind: "absent" },
    postcondition: { digest: digestOf(Buffer.from(BODY, "utf8")), manifestDigest: digestOf(Buffer.from("m")), auditDigest: digestOf(Buffer.from("a")) },
  };
}

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "art-adapter-")); await writeProfileFile(root, PROFILE); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function writeArtifact(body: string): Promise<void> {
  const paths = artifactPaths(root, TYPE, SLUG, "note.txt");
  const manifest: ArtifactManifest = { artifactType: TYPE, slug: SLUG, sha256: hashArtifactBody(body), bytes: Buffer.byteLength(body, "utf8"), contentKind: "text", writtenAt: "2026-07-19T00:00:00.000Z" };
  await writeArtifactFiles(root, paths, body, manifest);
}

async function writeBoundEvent(set: BindingSet): Promise<void> {
  await appendBoundEventLocked(root, { type: "artifact-write", origin: "sdk", payload: { artifactType: TYPE, slug: SLUG }, at: "2026-07-19T00:00:00.000Z" }, set.onDisk);
}

describe("artifactAdapter.observe", () => {
  it("reports not-applied when the artifact is absent", async () => {
    const set = makeBinding();
    expect((await artifactAdapter.observe(makeContext(root, artifactMutation(set), set))).outcome).toBe("not-applied");
  });

  it("reports applied when body, manifest, and bound event are present", async () => {
    await writeArtifact(BODY);
    const set = makeBinding();
    await writeBoundEvent(set);
    expect((await artifactAdapter.observe(makeContext(root, artifactMutation(set), set))).outcome).toBe("applied");
  });

  it("reports partially-applied when the artifact exists without its bound event", async () => {
    await writeArtifact(BODY);
    const set = makeBinding();
    const observation = await artifactAdapter.observe(makeContext(root, artifactMutation(set), set));
    expect(observation.outcome).toBe("partially-applied");
    expect(observation.auditRepairOnly).toBe(true);
  });

  it("reports conflict when the body digest mismatches the postcondition", async () => {
    await writeArtifact("different body\n");
    const set = makeBinding();
    expect((await artifactAdapter.observe(makeContext(root, artifactMutation(set), set))).outcome).toBe("conflict");
  });
});

describe("artifactAdapter.apply", () => {
  it("applies through the artifact authority with the trusted-write grant", async () => {
    process.env.LLMWIKI_TRUSTED_WRITE = "research";
    try {
      const set = makeBinding();
      await publishPayload(root, set.bundleId, Buffer.from(BODY, "utf8"));
      const ctx = makeContext(root, artifactMutation(set), set);
      expect((await artifactAdapter.apply(ctx)).status).toBe("applied");
      expect((await artifactAdapter.verify(ctx)).status).toBe("verified");
    } finally {
      delete process.env.LLMWIKI_TRUSTED_WRITE;
    }
  });
});

/**
 * @file test/operation-bundles/adapter-unavailable.test.ts
 * @description Task 3 tests proving each existing-store adapter reports
 * `unavailable` (never `not-applied`) when its backing store cannot be safely
 * read: a symlinked page/relation leaf, or an unreadable authority context.
 */

import { mkdtemp, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pageAdapter } from "../../src/operation-bundles/adapters/page.js";
import { relationAdapter } from "../../src/operation-bundles/adapters/relation.js";
import { lifecycleAdapter } from "../../src/operation-bundles/adapters/lifecycle.js";
import { artifactAdapter } from "../../src/operation-bundles/adapters/artifact.js";
import { writeProfileFile } from "../fixtures/profile-fixtures.js";
import type { EntityId, ProfilePack } from "../../src/profile/types.js";
import type {
  ArtifactOperationMutation, LifecycleOperationMutation, OperationDigest,
  PageOperationMutation, RelationOperationMutation,
} from "../../src/operation-bundles/types.js";
import { digestOf, makeBinding, makeContext } from "./adapter-fixtures.js";

const DUMMY = `sha256:${"3".repeat(64)}` as OperationDigest;
const NO_LIFECYCLE: ProfilePack = { schemaVersion: 1, profileId: "research", entities: { docs: { directory: "wiki/docs" } } };

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "unavail-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("adapters never collapse unavailable into not-applied", () => {
  it("page: a symlinked page leaf is unavailable", async () => {
    await mkdir(path.join(root, "wiki", "notes"), { recursive: true });
    await symlink("/etc/hostname", path.join(root, "wiki", "notes", "a.md"));
    const set = makeBinding();
    const mutation: PageOperationMutation = {
      kind: "page", index: 0, mutationId: set.onDisk.mutationId, dependsOn: [], reconciliationRefs: [],
      operation: "create", target: { kind: "raw", directory: "notes", slug: "a" }, payloadRef: "3".repeat(64),
      precondition: { kind: "absent" }, postcondition: { digest: DUMMY, byteCount: 1 },
    };
    expect((await pageAdapter.observe(makeContext(root, mutation, set))).outcome).toBe("unavailable");
  });

  it("relation: a symlinked relation store is unavailable", async () => {
    await writeProfileFile(root, { schemaVersion: 1, profileId: "research", entities: { experiments: { directory: "wiki/experiments" }, ideas: { directory: "wiki/ideas" } }, relations: { related: { from: ["experiments", "ideas"], to: ["experiments", "ideas"], direction: "symmetric" } } });
    await mkdir(path.join(root, "wiki", "graph"), { recursive: true });
    await symlink("/etc/hostname", path.join(root, "wiki", "graph", "relations.jsonl"));
    const set = makeBinding();
    const mutation: RelationOperationMutation = {
      kind: "relation", index: 0, mutationId: set.onDisk.mutationId, dependsOn: [], reconciliationRefs: [],
      operation: "create", target: { relationType: "related", from: "experiments/a" as EntityId, to: "ideas/b" as EntityId }, attributes: {},
      precondition: { kind: "absent" }, postcondition: { digest: DUMMY, recordId: "rel_x" },
    };
    expect((await relationAdapter.observe(makeContext(root, mutation, set))).outcome).toBe("unavailable");
  });

  it("lifecycle: an entity type with no lifecycle is unavailable", async () => {
    await writeProfileFile(root, NO_LIFECYCLE);
    const set = makeBinding();
    const mutation: LifecycleOperationMutation = {
      kind: "lifecycle-transition", index: 0, mutationId: set.onDisk.mutationId, dependsOn: [], reconciliationRefs: [],
      operation: "transition", target: { entityType: "docs", slug: "a" },
      precondition: { kind: "state", state: "draft", pageDigest: digestOf(Buffer.from("x")) },
      postcondition: { state: "published", pageDigest: DUMMY, eventDigest: DUMMY },
    };
    expect((await lifecycleAdapter.observe(makeContext(root, mutation, set))).outcome).toBe("unavailable");
  });

  it("artifact: an undeclared artifact type is unavailable", async () => {
    await writeProfileFile(root, NO_LIFECYCLE);
    const set = makeBinding();
    const mutation: ArtifactOperationMutation = {
      kind: "artifact", index: 0, mutationId: set.onDisk.mutationId, dependsOn: [], reconciliationRefs: [],
      operation: "create", target: { artifactType: "ghost", logicalId: "a" }, payloadRef: "3".repeat(64),
      precondition: { kind: "absent" }, postcondition: { digest: DUMMY, manifestDigest: DUMMY, auditDigest: DUMMY },
    };
    expect((await artifactAdapter.observe(makeContext(root, mutation, set))).outcome).toBe("unavailable");
  });
});

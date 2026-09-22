/**
 * @file test/operation-bundles/lifecycle-adapter.test.ts
 * @description Task 3 five-way observation tests for the lifecycle adapter, which
 * compares the entity page digest against the manifest states and requires the
 * bound audit event to distinguish applied from partially-applied.
 */

import { mkdtemp, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { lifecycleAdapter } from "../../src/operation-bundles/adapters/lifecycle.js";
import { appendBoundEventLocked } from "../../src/events/store.js";
import { writeProfileFile } from "../fixtures/profile-fixtures.js";
import type { ProfilePack } from "../../src/profile/types.js";
import type { LifecycleOperationMutation, OperationDigest } from "../../src/operation-bundles/types.js";
import { digestOf, makeBinding, makeContext, type BindingSet } from "./adapter-fixtures.js";

const PROFILE: ProfilePack = {
  schemaVersion: 1, profileId: "research",
  entities: { docs: { directory: "wiki/docs", lifecycle: { field: "status", initial: "draft", terminal: ["published"], transitions: { draft: ["published"], published: [] } } } },
};

const PRE = Buffer.from("---\nstatus: draft\n---\nbody\n");
const POST = Buffer.from("---\nstatus: published\n---\nbody\n");
const OTHER = Buffer.from("---\nstatus: archived\n---\nbody\n");

function lifecycleMutation(set: BindingSet): LifecycleOperationMutation {
  return {
    kind: "lifecycle-transition", index: 0, mutationId: set.onDisk.mutationId, dependsOn: [], reconciliationRefs: [],
    operation: "transition", target: { entityType: "docs", slug: "a" },
    precondition: { kind: "state", state: "draft", pageDigest: digestOf(PRE) },
    postcondition: { state: "published", pageDigest: digestOf(POST), eventDigest: `sha256:${"2".repeat(64)}` as OperationDigest },
  };
}

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "lc-adapter-")); await writeProfileFile(root, PROFILE); await mkdir(path.join(root, "wiki", "docs"), { recursive: true }); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function writePage(bytes: Buffer): Promise<void> {
  await writeFile(path.join(root, "wiki", "docs", "a.md"), bytes);
}

async function writeBoundEvent(set: BindingSet): Promise<void> {
  await appendBoundEventLocked(root, { type: "lifecycle-transition", origin: "sdk", payload: { entityType: "docs", slug: "a", to: "published" }, at: "2026-07-19T00:00:00.000Z" }, set.onDisk);
}

describe("lifecycleAdapter.observe", () => {
  it("observes through a non-canonical root alias", async () => {
    await writePage(PRE);
    const aliasParent = await mkdtemp(path.join(os.tmpdir(), "lc-adapter-alias-"));
    const alias = path.join(aliasParent, "project");
    await symlink(root, alias, "dir");
    try {
      const set = makeBinding();
      expect((await lifecycleAdapter.observe(makeContext(alias, lifecycleMutation(set), set))).outcome).toBe("not-applied");
    } finally {
      await rm(aliasParent, { recursive: true, force: true });
    }
  });

  it("reports not-applied at the precondition state", async () => {
    await writePage(PRE);
    const set = makeBinding();
    expect((await lifecycleAdapter.observe(makeContext(root, lifecycleMutation(set), set))).outcome).toBe("not-applied");
  });

  it("reports applied at the postcondition state with the bound event", async () => {
    await writePage(POST);
    const set = makeBinding();
    await writeBoundEvent(set);
    expect((await lifecycleAdapter.observe(makeContext(root, lifecycleMutation(set), set))).outcome).toBe("applied");
  });

  it("reports partially-applied at the postcondition state without the bound event", async () => {
    await writePage(POST);
    const set = makeBinding();
    const observation = await lifecycleAdapter.observe(makeContext(root, lifecycleMutation(set), set));
    expect(observation.outcome).toBe("partially-applied");
    expect(observation.auditRepairOnly).toBe(true);
  });

  it("reports conflict when the page matches neither state", async () => {
    await writePage(OTHER);
    const set = makeBinding();
    expect((await lifecycleAdapter.observe(makeContext(root, lifecycleMutation(set), set))).outcome).toBe("conflict");
  });
});

describe("lifecycleAdapter.apply", () => {
  it("parks an invalid transition as conflict", async () => {
    await writePage(OTHER); // status: archived — not a valid draft->published source
    const set = makeBinding();
    const result = await lifecycleAdapter.apply(makeContext(root, lifecycleMutation(set), set));
    expect(result.status).toBe("conflict");
  });
});

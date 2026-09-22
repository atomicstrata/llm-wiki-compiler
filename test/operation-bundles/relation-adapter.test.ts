/**
 * @file test/operation-bundles/relation-adapter.test.ts
 * @description Task 3 observation + apply tests for the relation adapter: apply
 * through the operation-aware seam yields applied; an authority record without
 * its child audit event is partially applied; invalid content parks.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { relationAdapter } from "../../src/operation-bundles/adapters/relation.js";
import { relationContentHash } from "../../src/relations/digest.js";
import { appendLine, appendRelation, buildRelationRef } from "../../src/relations/store.js";
import { readRelationRecords } from "../../src/relations/store-read.js";
import { writeProfileFile } from "../fixtures/profile-fixtures.js";
import type { EntityId, ProfilePack } from "../../src/profile/types.js";
import type { OperationDigest, RelationOperationMutation } from "../../src/operation-bundles/types.js";
import { makeBinding, makeContext, type BindingSet } from "./adapter-fixtures.js";

const PROFILE: ProfilePack = {
  schemaVersion: 1, profileId: "research",
  entities: { experiments: { directory: "wiki/experiments" }, ideas: { directory: "wiki/ideas" } },
  relations: { related: { from: ["experiments", "ideas"], to: ["experiments", "ideas"], direction: "symmetric" } },
};

const DUMMY = `sha256:${"1".repeat(64)}` as OperationDigest;
const relInput = { type: "related", from: "experiments/a" as EntityId, to: "ideas/b" as EntityId };

/** The digest the postcondition must attest: the store's own content hash. */
const CANONICAL = `sha256:${buildRelationRef(PROFILE, relInput).contentHash}` as OperationDigest;

function relationMutation(set: BindingSet, relationType = "related"): RelationOperationMutation {
  return {
    kind: "relation", index: 0, mutationId: set.onDisk.mutationId, dependsOn: [], reconciliationRefs: [],
    operation: "create", target: { relationType, from: "experiments/a", to: "ideas/b" }, attributes: {},
    precondition: { kind: "absent" }, postcondition: { digest: relationType === "related" ? CANONICAL : DUMMY, recordId: "rel_x" },
  };
}

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "rel-adapter-")); await writeProfileFile(root, PROFILE); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("relationAdapter", () => {
  it("observes not-applied on a fresh store", async () => {
    const set = makeBinding();
    expect((await relationAdapter.observe(makeContext(root, relationMutation(set), set))).outcome).toBe("not-applied");
  });

  it("applies through the operation seam and then observes applied", async () => {
    const set = makeBinding();
    const ctx = makeContext(root, relationMutation(set), set);
    expect((await relationAdapter.apply(ctx)).status).toBe("applied");
    expect((await relationAdapter.observe(ctx)).outcome).toBe("applied");
    expect((await relationAdapter.verify(ctx)).status).toBe("verified");
  });

  it("observes partially-applied when the relation exists without its bound event", async () => {
    await appendRelation(root, PROFILE, relInput); // ordinary create: no operation-bound event
    const set = makeBinding();
    const observation = await relationAdapter.observe(makeContext(root, relationMutation(set), set));
    expect(observation.outcome).toBe("partially-applied");
    expect(observation.auditRepairOnly).toBe(true);
  });

  it("parks content invalid for the active profile as conflict", async () => {
    const set = makeBinding();
    const observation = await relationAdapter.observe(makeContext(root, relationMutation(set, "undeclared"), set));
    expect(observation.outcome).toBe("conflict");
  });

  it("dedupes to a pre-existing same-content relation and NAMES its id", async () => {
    // The promised recordId binds only records this mutation CREATES; identical
    // content already lives under a minted id, so the skip must carry THAT id
    // observably — a silent skip would let the manifest attest an id that
    // exists nowhere while verify still passes on content grounds.
    const existing = await appendRelation(root, PROFILE, relInput);
    const set = makeBinding();
    const ctx = makeContext(root, relationMutation(set), set);
    const outcome = await relationAdapter.apply(ctx);
    if (outcome.status !== "skipped-idempotent") throw new Error(JSON.stringify(outcome));
    expect(outcome.boundToMutation).toBe(false);
    expect(outcome.detail).toContain(existing.id);
    expect((await relationAdapter.verify(ctx)).status).toBe("verified");
  });

  it("applies a symmetric relation DECLARED in the non-canonical order", async () => {
    // The digest binds the DECLARED payload; the store canonicalizes. A valid
    // declaration in either endpoint order must apply — conflicting here was a
    // retry trap (the re-attestation is deterministic, so it could never land).
    const declared = { type: "related", from: "ideas/b" as EntityId, to: "experiments/a" as EntityId };
    const set = makeBinding();
    const mutation: RelationOperationMutation = {
      ...relationMutation(set), target: { relationType: "related", from: "ideas/b", to: "experiments/a" },
      postcondition: {
        digest: `sha256:${relationContentHash({ ...declared, attributes: {}, evidence: undefined })}` as OperationDigest,
        recordId: "rel_y",
      },
    };
    const ctx = makeContext(root, mutation, set);
    expect((await relationAdapter.apply(ctx)).status).toBe("applied");
    const { records } = await readRelationRecords(root);
    // Persisted content is canonical(declared): the same record the canonical
    // declaration would have written, under the promised id.
    expect(records[0]!.ref.contentHash).toBe(buildRelationRef(PROFILE, declared).contentHash);
    expect(records[0]!.ref.id).toBe("rel_y");
    expect((await relationAdapter.verify(ctx)).status).toBe("verified");
  });

  it("conflicts when the attested digest is not the mutation's own declared content", async () => {
    const set = makeBinding();
    const mutation = { ...relationMutation(set), postcondition: { digest: DUMMY, recordId: "rel_x" } };
    const outcome = await relationAdapter.apply(makeContext(root, mutation, set));
    if (outcome.status !== "conflict") throw new Error(JSON.stringify(outcome));
    expect(outcome.detail).toMatch(/declared content hash/);
  });

  it("a bound event cannot vouch for a BOGUS attested digest", async () => {
    // Land the honest mutation (record + bound child event) — then re-read the
    // SAME mutation with a corrupted digest. Content presence and the bound
    // event are true facts, but they cannot make a digest that never bound the
    // declared bytes true: every vouching leg runs the one declared-digest
    // predicate, so observe refuses and verify mismatches.
    const set = makeBinding();
    await relationAdapter.apply(makeContext(root, relationMutation(set), set));
    const bogus = { ...relationMutation(set), postcondition: { digest: DUMMY, recordId: "rel_x" } };
    const ctx = makeContext(root, bogus, set);
    const observation = await relationAdapter.observe(ctx);
    expect(observation.outcome).toBe("conflict");
    expect(observation.detail).toMatch(/declared content hash/);
    expect((await relationAdapter.verify(ctx)).status).toBe("mismatch");
  });

  it("conflicts when the promised id is already live with DIFFERENT content", async () => {
    // Appending under a live id would silently supersede the live relation —
    // the reader keeps the newest record per id — so an id collision refuses.
    const other = { type: "related", from: "experiments/other" as EntityId, to: "ideas/b" as EntityId };
    await appendLine(root, buildRelationRef(PROFILE, other, "rel_x"));
    const set = makeBinding();
    const outcome = await relationAdapter.apply(makeContext(root, relationMutation(set), set));
    if (outcome.status !== "conflict") throw new Error(JSON.stringify(outcome));
    expect(outcome.detail).toMatch(/already live with different content/);
  });
});

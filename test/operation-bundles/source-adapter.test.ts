/**
 * @file test/operation-bundles/source-adapter.test.ts
 * @description Task 4 tests for the retained-source adapter: the target is a
 * content-address digest that cannot name a path, apply publishes create-only and
 * is idempotent, and a fresh store observes not-applied.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { sourceAdapter } from "../../src/operation-bundles/adapters/source.js";
import type { SourceRetainMutation } from "../../src/operation-bundles/types.js";
import { digestOf, makeBinding, makeContext, publishPayload, type BindingSet } from "./adapter-fixtures.js";

const BYTES = Buffer.from("retained source content\n");
const HEX = createHash("sha256").update(BYTES).digest("hex");

function sourceMutation(set: BindingSet, digest = HEX): SourceRetainMutation {
  return {
    kind: "source-retain", index: 0, mutationId: set.onDisk.mutationId, dependsOn: [], reconciliationRefs: [],
    operation: "create", target: { digest }, payloadRef: HEX,
    precondition: { kind: "absent-or-same", digest: digestOf(BYTES), byteCount: BYTES.byteLength },
    postcondition: { digest: digestOf(BYTES), byteCount: BYTES.byteLength },
  };
}

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "src-adapter-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("sourceAdapter", () => {
  it("observes not-applied on a fresh store", async () => {
    const set = makeBinding();
    expect((await sourceAdapter.observe(makeContext(root, sourceMutation(set), set))).outcome).toBe("not-applied");
  });

  it("publishes create-only and then observes applied", async () => {
    const set = makeBinding();
    await publishPayload(root, set.bundleId, BYTES);
    const ctx = makeContext(root, sourceMutation(set), set);
    expect((await sourceAdapter.apply(ctx)).status).toBe("applied");
    expect((await sourceAdapter.observe(ctx)).outcome).toBe("applied");
    expect((await sourceAdapter.apply(ctx)).status).toBe("skipped-idempotent");
  });

  it("parks a target that is not a content-address digest as conflict", async () => {
    const set = makeBinding();
    const observation = await sourceAdapter.observe(makeContext(root, sourceMutation(set, "../escape"), set));
    expect(observation.outcome).toBe("conflict");
  });
});

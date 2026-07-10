/**
 * @file test/relation-lifecycle-audit-residual.test.ts
 * @description Cross-store audit-residual coverage for the relation/lifecycle
 * executor kinds (Phase 4, Task 6).
 *
 * ENFORCED GUARANTEE — PRE-FLIGHT FAIL-CLOSED: both executor kinds run the
 * mandatory `prepareEventStoreForAppend` pre-flight UNDER THE HELD LOCK *before*
 * mutating their store (relation append / page write). A tampered / symlinked /
 * too-new event store therefore fails the write CLOSED with NOTHING written: no
 * relation is appended, and the page's lifecycle field is unchanged. This file
 * plants such a store the way the event-store tests do (symlinked leaf,
 * too-new schemaVersion) and asserts both public surfaces refuse.
 *
 * KNOWN RESIDUAL — MID-EMIT (Phase-5 cross-store-atomicity gap, NOT asserted):
 * a store that is HEALTHY at pre-flight but fails LATER, mid-emit, AFTER the
 * mutation has already landed, leaves the mutation WITHOUT its audit event. The
 * order in both handlers is: pre-flight → write the mutation → emit the event
 * (relations/store.ts `appendRelationLocked`; trust/lifecycle-apply.ts
 * `applyLifecycleLocked`). Co-commit across the two stores is NOT guaranteed and
 * is deliberately deferred to Phase 5 (guarded by CrossStoreBatchUnsupportedError
 * for batches). We do NOT assert co-commit here. A deterministic mid-emit failure
 * cannot be injected without a production seam (the emit path has no test hook),
 * so the residual is DOCUMENTED rather than asserted — fabricating a passing
 * co-commit assertion would mis-state the guarantee.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EntityId } from "../src/profile/types.js";
import { createWiki } from "../src/index.js";
import { readRelations } from "../src/relations/store-read.js";
import { EVENTS_FILE } from "../src/utils/constants.js";
import { buildSeamProject, pageLifecycle } from "./fixtures/seam-fixtures.js";

const PAPER_A = "papers/a" as EntityId;
const PAPER_B = "papers/b" as EntityId;

/** Plant a TOO-NEW event-store header so the pre-flight read fails closed. */
async function plantTooNewEventStore(root: string): Promise<void> {
  await mkdir(path.join(root, path.dirname(EVENTS_FILE)), { recursive: true });
  await writeFile(path.join(root, EVENTS_FILE), '{"kind":"event-store-header","schemaVersion":99}\n', "utf8");
}

/** Plant a SYMLINKED event-store leaf (escape) so the pre-flight read fails closed. */
async function plantSymlinkedEventStore(root: string): Promise<string> {
  const outside = await mkdtemp(path.join(os.tmpdir(), "evt-escape-"));
  await mkdir(path.join(root, path.dirname(EVENTS_FILE)), { recursive: true });
  await writeFile(path.join(outside, "leak.jsonl"), "x", "utf8");
  await symlink(path.join(outside, "leak.jsonl"), path.join(root, EVENTS_FILE));
  return outside;
}

/** Assert createRelation fails closed at pre-flight: rejects AND nothing appended. */
async function expectRelationFailsClosed(root: string): Promise<void> {
  const wiki = createWiki({ root });
  await expect(
    wiki.createRelation({ type: "cites", from: PAPER_A, to: PAPER_B, attributes: {} }),
  ).rejects.toBeTruthy();
  expect((await readRelations(root)).relations).toHaveLength(0);
}

/** Assert transitionLifecycle fails closed at pre-flight: rejects AND page unchanged. */
async function expectLifecycleFailsClosed(root: string): Promise<void> {
  const wiki = createWiki({ root });
  await expect(
    wiki.transitionLifecycle({ entityType: "papers", slug: "a", toState: "review" }),
  ).rejects.toBeTruthy();
  expect(await pageLifecycle(root, "a")).toBe("draft");
}

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rel-lc-residual-"));
  await buildSeamProject(root, ["a"]);
});
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("pre-flight fail-closed: a too-new audit store blocks both kinds", () => {
  it("createRelation fails closed at pre-flight — nothing appended", async () => {
    await plantTooNewEventStore(root);
    await expectRelationFailsClosed(root);
  });

  it("transitionLifecycle fails closed at pre-flight — page lifecycle unchanged", async () => {
    await plantTooNewEventStore(root);
    await expectLifecycleFailsClosed(root);
  });
});

describe("pre-flight fail-closed: a symlinked audit leaf blocks both kinds", () => {
  let outside = "";
  afterEach(async () => {
    if (outside) await rm(outside, { recursive: true, force: true });
    outside = "";
  });

  it("createRelation refuses a symlinked event store — nothing appended", async () => {
    outside = await plantSymlinkedEventStore(root);
    await expectRelationFailsClosed(root);
  });

  it("transitionLifecycle refuses a symlinked event store — page unchanged", async () => {
    outside = await plantSymlinkedEventStore(root);
    await expectLifecycleFailsClosed(root);
  });
});

/**
 * KNOWN RESIDUAL (documented, not asserted — see file header): a store healthy
 * at pre-flight that fails mid-emit AFTER the mutation lands leaves the mutation
 * without its event. The emit path exposes no production test seam, so a
 * deterministic mid-emit failure cannot be injected; asserting co-commit here
 * would mis-state the Phase-5 cross-store-atomicity gap. Left as this comment.
 */

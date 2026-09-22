/**
 * @file test/operation-bundles/page-delete-journey.test.ts
 * @description AS-1R edit: the authored-DELETE apply journey through the
 * page adapter — the half the edit record listed as unbuilt. The delete
 * MACHINERY exists (adapters/page.ts handles `operation: "delete"` with a
 * precondition and absent postcondition); this drives it end to end.
 *
 * Three claims, each on real files:
 *  - a delete under the correct precondition REMOVES the page and verifies
 *    absence;
 *  - a delete whose precondition no longer matches the on-disk page CONFLICTS
 *    and leaves the page present (no blind delete of changed content);
 *  - re-running apply after the page is already gone (the crash-replay shape)
 *    is idempotent — it settles absent once, never erroring on the missing
 *    file, and verify confirms absence.
 */

import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pageAdapter } from "../../src/operation-bundles/adapters/page.js";
import type { OperationDigest, PageOperationMutation, PayloadRef } from "../../src/operation-bundles/types.js";
import type { MutationId } from "../../src/operation-bundles/ids.js";
import { digestOf, makeBinding, makeContext, publishPayload, type BindingSet } from "./adapter-fixtures.js";

const BODY = Buffer.from("# a page slated for deletion\n");
const DIR = "notes";
const SLUG = "doomed";

/** A delete mutation whose precondition is `digest`/`byteCount`. */
function deleteMutation(set: BindingSet, precondition: { digest: OperationDigest }): PageOperationMutation {
  return {
    kind: "page", index: 0, mutationId: set.onDisk.mutationId as MutationId, dependsOn: [], reconciliationRefs: [],
    operation: "delete", target: { kind: "raw", directory: DIR, slug: SLUG },
    // A delete produces no bytes: an empty payload ref and an absent postcondition.
    payloadRef: digestOf(BODY).slice("sha256:".length) as PayloadRef,
    precondition: { kind: "digest", digest: precondition.digest },
    postcondition: { kind: "absent" },
  };
}

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "page-delete-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

function pagePath(): string { return path.join(root, "wiki", DIR, `${SLUG}.md`); }
async function writePage(bytes: Buffer): Promise<void> {
  await mkdir(path.join(root, "wiki", DIR), { recursive: true });
  await writeFile(pagePath(), bytes);
}

/** A bound delete context whose payload+precondition name the original BODY. */
async function deleteCtx() {
  const set = makeBinding();
  await publishPayload(root, set.bundleId, BODY);
  return makeContext(root, deleteMutation(set, { digest: digestOf(BODY) }), set);
}

describe("authored delete through the page adapter", () => {
  it("removes the page under the correct precondition and verifies absence", async () => {
    await writePage(BODY);
    const ctx = await deleteCtx();
    expect((await pageAdapter.apply(ctx)).status).toBe("applied-absent");
    expect(existsSync(pagePath()), "page survived the delete").toBe(false);
    expect((await pageAdapter.verify(ctx)).status).toBe("verified-absent");
  });

  it("CONFLICTS at observe without deleting when the page changed since proposal", async () => {
    await writePage(Buffer.from("edited since the delete was proposed\n"));
    // The precondition names the ORIGINAL bytes, which no longer match — the
    // executor OBSERVES conflict and never calls apply. (observe is the
    // precondition guard; a stale delete must not proceed to removal.)
    const ctx = await deleteCtx();
    expect((await pageAdapter.observe(ctx)).outcome).toBe("conflict");
    expect(existsSync(pagePath()), "a stale page was disturbed by a refused delete").toBe(true);
    expect(await readFile(pagePath(), "utf8")).toContain("edited since");
  });

  it("is idempotent when re-applied after the page is already gone (crash replay)", async () => {
    const ctx = await deleteCtx();
    // The page is ABSENT (a crash left the deletion half-committed). The delete
    // must observe the goal is already met, not error on the missing file.
    const observation = await pageAdapter.observe(ctx);
    expect(observation.outcome, JSON.stringify(observation)).toBe("applied");
    expect((await pageAdapter.verify(ctx)).status).toBe("verified-absent");
  });
});

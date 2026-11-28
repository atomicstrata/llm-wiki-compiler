/**
 * @file test/scale/downgrade-catalog-identity.test.ts
 * @description The workspace identity of every segmented operation catalog a
 * scale-down binds. A catalog store (`opcat-…`) counts as a workspace's
 * catalog only when its manifest names a string `workspaceId` that hashes to
 * the store's own name (`operationCatalogStore`), exactly the identity the
 * indexed store verification already requires. Any other manifest is an
 * `indexed_inventory_invalid` blocker naming the store, never a silent
 * omission: an omitted catalog would get no export unit, so the preview would
 * report a scale-down ready that the apply's locked verification then refuses.
 *
 * - Plain manifests (no indexed build; `indexedFacts` only reads manifest
 *   leaves): a valid identity is listed with no blocker; a missing, non-string
 *   or mismatched one is blocked and never listed. In every case the store
 *   stays bound by its exact manifest digest.
 * - A REAL indexed project (built in a child process): its catalog manifest's
 *   identity is removed (the manifest stays parseable). The PUBLIC SDK preview
 *   (`wiki.scale.downgrade.preview`, in a child, because a preview reads the
 *   stores under a reader lease) reports not ready and its plan names the
 *   store; the apply (a fresh child) refuses before any fence, intent or
 *   archive; and the store verification the apply relies on still fails the
 *   store. The verification runs last, in this process, after every child.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach } from "../config/storage-profile-hooks.js";
import { OPERATION_CATALOG_STORE_PREFIX, operationCatalogStore } from "../../src/history/operation-catalog.js";
import { verifyIndexedStores } from "../../src/indexed/verify.js";
import { SCALE_RECORD_FILE } from "../../src/scale/contracts.js";
import { DOWNGRADE_DIR, DOWNGRADE_INTENT_FILE } from "../../src/scale/downgrade-contracts.js";
import { indexedFacts } from "../../src/scale/downgrade-indexed-facts.js";
import { INDEXED_DIR, MANIFEST_LEAF } from "../../src/segments/contracts.js";
import { sha256Hex } from "../../src/segments/format.js";
import { emptyManifest, serializeManifest } from "../../src/segments/manifest.js";
import { CASE_TIMEOUT_MS, downgradeMode, ok, planFileFor, useDowngradeProjects } from "./downgrade-helpers.js";

/** The workspace the plain fixtures name, and the catalog store its id hashes to. */
const WORKSPACE = "ws-a";
const STORE = operationCatalogStore(WORKSPACE);

/** The blocker a catalog store without a valid workspace identity carries. */
const invalidIdentity = (store: string) => ({ code: "indexed_inventory_invalid", detail: `store ${store}: its manifest names no valid workspace` });

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** A plain project holding ONE catalog store `name` whose manifest carries `meta`; returns its root and the manifest's digest. */
async function catalogStoreProject(name: string, meta: Record<string, unknown>): Promise<{ root: string; sha: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-catalog-identity-"));
  roots.push(root);
  const dir = path.join(root, INDEXED_DIR, name);
  await mkdir(dir, { recursive: true });
  const bytes = serializeManifest({ ...emptyManifest(name), generation: 1, meta });
  await writeFile(path.join(dir, MANIFEST_LEAF), bytes);
  return { root, sha: sha256Hex(bytes) };
}

describe("the catalog identity an indexed scale-down binds (plain manifests)", () => {
  it("lists a catalog store whose workspace id hashes to its name, with no blocker", async () => {
    const { root, sha } = await catalogStoreProject(STORE, { workspaceId: WORKSPACE });
    const facts = await indexedFacts(root);
    expect([facts.workspaces, facts.blockers, facts.stores]).toEqual([[WORKSPACE], [], [{ name: STORE, manifestSha256: sha }]]);
  });

  it.each([
    ["no workspaceId", {}],
    ["a non-string workspaceId", { workspaceId: 7 }],
    ["a workspaceId that hashes to another store", { workspaceId: "ws-b" }],
  ] as const)("blocks a catalog store whose manifest names %s, never lists it, and keeps its digest bound", async (_label, meta) => {
    const { root, sha } = await catalogStoreProject(STORE, meta);
    const facts = await indexedFacts(root);
    expect(facts.workspaces).toEqual([]);
    expect(facts.stores).toEqual([{ name: STORE, manifestSha256: sha }]);
    expect(facts.blockers).toEqual([invalidIdentity(STORE)]);
  });
});

const projects = useDowngradeProjects();

/** The one workspace catalog store of the built project at `root`. */
async function catalogStoreOf(root: string): Promise<string> {
  const names = (await readdir(path.join(root, INDEXED_DIR))).filter((name) => name.startsWith(OPERATION_CATALOG_STORE_PREFIX));
  expect(names).toHaveLength(1);
  return names[0]!;
}

/** Rewrite `store`'s manifest without its workspace id, keeping it parseable: a damaged identity. */
async function dropWorkspaceId(root: string, store: string): Promise<void> {
  const file = path.join(root, INDEXED_DIR, store, MANIFEST_LEAF);
  const manifest = JSON.parse(await readFile(file, "utf8")) as { meta: Record<string, unknown> };
  delete manifest.meta.workspaceId;
  await writeFile(file, JSON.stringify(manifest));
}

/** The blockers of the saved plan file `planFile`. */
async function planBlockers(planFile: string): Promise<unknown[]> {
  return (JSON.parse(await readFile(planFile, "utf8")) as { inventory: { blockers: unknown[] } }).inventory.blockers;
}

describe("a damaged catalog identity on a real indexed project", () => {
  it("blocks the public preview, the apply refuses before any fence, and the store verification still fails it", async () => {
    const root = await projects.build("build");
    const store = await catalogStoreOf(root);
    await dropWorkspaceId(root, store);
    const record = await readFile(path.join(root, SCALE_RECORD_FILE));
    const planFile = planFileFor(root);
    expect(await ok("sdk-preview", root, planFile)).toEqual({ change: "none", ready: false });
    expect(await planBlockers(planFile)).toContainEqual(invalidIdentity(store));
    expect((await downgradeMode("apply", root, planFile)).outcome).toBe("scale_downgrade_blocked");
    expect((await readFile(path.join(root, SCALE_RECORD_FILE))).equals(record)).toBe(true);
    const privateDir = await readdir(path.join(root, ".llmwiki"));
    expect(privateDir).not.toContain(path.basename(DOWNGRADE_INTENT_FILE));
    expect(privateDir).not.toContain(path.basename(DOWNGRADE_DIR));
    const verified = await verifyIndexedStores(root);
    expect(verified.ok).toBe(false);
    expect(JSON.stringify(verified.stores)).toContain("its manifest is missing or names another workspace");
  }, CASE_TIMEOUT_MS);
});

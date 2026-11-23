/**
 * @file test/indexed/restore-refusals.test.ts
 * @description Every preflight refusal of an indexed-authority restore leaves
 * NO marker and changes nothing: a corrupted or index-less backup, a missing
 * offline assertion, a target store the backup lacks, a target workspace
 * holding operation-catalog authority the backup lacks, a different project
 * root, a live reader found by the census after the marker, and a failure
 * while recording the original states (its no-effect marker is removed).
 */

import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, open, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeAll } from "../config/storage-profile-hooks.js";
import { resolveStorageTestProfile } from "../config/storage-test-profile.js";
import { legacyCatalogPath } from "../../src/history/operation-catalog.js";
import { appendCatalogRecordLocked, createCatalogRecord } from "../../src/operation-bundles/catalog-store.js";
import { restoreIndexedBackup } from "../../src/indexed/restore.js";
import { childEnd, startChild } from "../helpers-child-process.js";
import { activated, backedUp, child, cleanup, markerPresent, owned, restoreChild } from "./restore-helpers.js";
import { waitFor } from "./gc-helpers.js";

/**
 * These tests chain several real child processes (activate, backup, restore,
 * verify, list), each with durable writes; on the EJ8T USB disk one such chain
 * measured 27-31 s serially, so each gets an explicit, measured limit.
 */
const CHILD_CHAIN_TIMEOUT_MS = 120_000;

/**
 * All cases here activate a project and make a durable backup. That shared
 * setup alone took about 121 s in CP82, before either refusal assertion; the
 * held-reader chain also exceeded 120 s in CP81. Give these explicit child
 * chains bounded headroom under the named slow-storage profile. Normal
 * storage and the case using the profile default keep their original limits.
 */
const REFUSAL_CHAIN_SLOW_STORAGE_TIMEOUT_MS = 600_000;

/** The explicit child-chain limit for the selected storage profile. */
const refusalChainTimeoutMs = resolveStorageTestProfile(process.env.LLMWIKI_TEST_STORAGE_PROFILE).profile === "slow-durable-storage"
  ? REFUSAL_CHAIN_SLOW_STORAGE_TIMEOUT_MS
  : CHILD_CHAIN_TIMEOUT_MS;

beforeAll(async () => { await restoreChild(); });
afterEach(cleanup);

/** Expect a restore of `root` from `dir` to refuse with `code`, leaving no marker. */
async function expectRefused(root: string, dir: string, code: string): Promise<void> {
  const outcome = await child("restore", root, dir);
  expect(outcome.outcome, String(outcome.message)).toBe(code);
  expect(markerPresent(root)).toBe(false);
}

/** Snapshot indexed authority names, kinds and file bytes without following links. */
async function indexedAuthorityTree(root: string): Promise<string[]> {
  const base = path.join(root, ".llmwiki", "indexed");
  const rows: string[] = [];
  /** Visit one directory, recording its own presence as well as its children. */
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(base, full).split(path.sep).join("/");
      if (entry.isDirectory()) { rows.push(`directory:${relative}`); await visit(full); }
      else if (entry.isFile()) rows.push(`file:${relative}:${createHash("sha256").update(await readFile(full)).digest("hex")}`);
      else if (entry.isSymbolicLink()) rows.push(`link:${relative}:${await readlink(full)}`);
      else rows.push(`other:${relative}`);
    }
  }
  await visit(base);
  return rows.sort();
}

describe("an unusable backup", () => {
  it("with a corrupted segment, or without its index", async () => {
    const root = await activated();
    const dir = await backedUp(root);
    const index = JSON.parse(await readFile(path.join(dir, "backup.json"), "utf8")) as { stores: { store: string; segments: { name: string }[] }[] };
    const catalog = index.stores.find((s) => s.store === "catalog")!;
    const handle = await open(path.join(dir, "tree", ".llmwiki", "indexed", "catalog", catalog.segments[0]!.name), "r+");
    await handle.write(Buffer.from("Z"), 0, 1, 24);
    await handle.close();
    const before = await indexedAuthorityTree(root);
    await expectRefused(root, dir, "indexed_restore_invalid_backup");
    expect(await indexedAuthorityTree(root)).toEqual(before);
    await rm(path.join(dir, "backup.json"));
    await expectRefused(root, dir, "indexed_restore_invalid_backup");
  }, refusalChainTimeoutMs);
});

describe("prerequisites", () => {
  it("refuse without the offline assertion", async () => {
    const root = await activated();
    const dir = await backedUp(root);
    await expect(restoreIndexedBackup(root, dir)).rejects.toThrow(/indexed_restore_offline_unconfirmed/);
    expect(markerPresent(root)).toBe(false);
  });

  it("refuse a target store the backup lacks, and a different project root", async () => {
    const root = await activated();
    const dir = await backedUp(root);
    await mkdir(path.join(root, ".llmwiki", "indexed", "extra"));
    await expectRefused(root, dir, "indexed_restore_prerequisite");
    await rm(path.join(root, ".llmwiki", "indexed", "extra"), { recursive: true });
    const clone = await mkdtemp(path.join(tmpdir(), "llmwiki-restore-clone-"));
    owned.push(clone);
    await cp(root, clone, { recursive: true });
    const before = await indexedAuthorityTree(clone);
    await expectRefused(clone, dir, "indexed_restore_prerequisite");
    expect(await indexedAuthorityTree(clone)).toEqual(before);
  }, refusalChainTimeoutMs);
});

describe("the census after the marker", () => {
  it("refuses while another process holds a reader lease, and removes its no-effect marker", async () => {
    const root = await activated();
    const dir = await backedUp(root);
    const ready = path.join(dir, "..", `${path.basename(dir)}.ready`);
    const go = path.join(dir, "..", `${path.basename(dir)}.go`);
    owned.push(ready, go);
    const holder = startChild(await restoreChild(), ["hold", root, ready, go]);
    const held = childEnd(holder);
    try {
      await waitFor(ready);
      await expectRefused(root, dir, "indexed_restore_readers_active");
    } finally {
      await writeFile(go, "go");
      await held;
    }
  }, refusalChainTimeoutMs);
});

describe("more prerequisites", () => {
  it("refuse a target workspace holding operation-catalog authority the backup lacks; an empty workspace passes the check", async () => {
    const root = await activated();
    const dir = await backedUp(root);
    await mkdir(path.join(root, ".llmwiki", "workspaces", "empty-one"), { recursive: true });
    // A genuine incumbent catalog file, written by the real body in a NON-indexed scratch project, then copied in.
    const scratch = await mkdtemp(path.join(tmpdir(), "llmwiki-stray-"));
    owned.push(scratch);
    const record = createCatalogRecord({ logicalRecordId: "l-stray", mutationId: `opm_${"e".repeat(64)}`, payload: {}, createdAt: "2026-10-26T00:00:00.000Z" });
    expect(await appendCatalogRecordLocked(scratch, "stray", record)).toBe("created");
    await cp(path.join(scratch, path.dirname(legacyCatalogPath(scratch, "stray"))), path.join(root, path.dirname(legacyCatalogPath(root, "stray"))), { recursive: true });
    const outcome = await child("restore", root, dir);
    // The maintenance acquisition's read-only bundle leg already blocks an unimported workspace catalog the
    // backup does not restore (`indexed_maintenance_blocked`); the restore preflight check is the second,
    // independent refusal. Either way the refusal comes before any marker or effect.
    expect(["indexed_restore_prerequisite", "indexed_maintenance_blocked"]).toContain(outcome.outcome);
    expect(String(outcome.message)).not.toMatch(/empty-one/);
    expect(markerPresent(root)).toBe(false);
  }, refusalChainTimeoutMs);

  it("leave no marker when recording the original states fails", async () => {
    const root = await activated();
    const dir = await backedUp(root);
    await rm(path.join(root, ".llmwiki", "events.head"), { force: true });
    await mkdir(path.join(root, ".llmwiki", "events.head"));
    await expectRefused(root, dir, "indexed_restore_conflict");
  }, refusalChainTimeoutMs);
});

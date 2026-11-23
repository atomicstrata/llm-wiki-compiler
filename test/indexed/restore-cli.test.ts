/**
 * @file test/indexed/restore-cli.test.ts
 * @description The bundled `llmwiki catalog restore` command body's envelope when a
 * restore stops AFTER installation began: exit 4 with `recoveryRequired`, the
 * marker path and the resume instruction, the marker left in place; once the
 * fault is gone, re-running the same restore resumes, removes the marker and
 * the project verifies. And a backup of a project holding operation-catalog
 * authority it would omit writes no backup index. Every process that reads
 * the fixture's stores is a CHILD.
 */

import { existsSync } from "node:fs";
import { chmod, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeAll } from "../config/storage-profile-hooks.js";
import { resolveStorageTestProfile } from "../config/storage-test-profile.js";
import { legacyCatalogPath } from "../../src/history/operation-catalog.js";
import { appendCatalogRecordLocked, createCatalogRecord } from "../../src/operation-bundles/catalog-store.js";
import { activated, backedUp, child, cleanup, markerPresent, owned, restoreChild } from "./restore-helpers.js";

/** Child chains of real durable writes on the external disk; measured, explicit. */
const CHILD_CHAIN_TIMEOUT_MS = 120_000;

/**
 * The interrupted-restore case spent about 35 s activating and 68 s backing
 * up on slow external storage, leaving only 17 s of its 120 s limit for the
 * first restore, resume and verification. Give that complete chain bounded
 * headroom only under the explicit slow profile; normal storage keeps 120 s.
 */
const RECOVERY_CHAIN_SLOW_STORAGE_TIMEOUT_MS = 600_000;

/** The interrupted-restore case's limit for the explicitly selected profile. */
const recoveryChainTimeoutMs = resolveStorageTestProfile(process.env.LLMWIKI_TEST_STORAGE_PROFILE).profile === "slow-durable-storage"
  ? RECOVERY_CHAIN_SLOW_STORAGE_TIMEOUT_MS
  : CHILD_CHAIN_TIMEOUT_MS;
/** A store directory that can be listed but not written: publication into it fails. */
const READ_ONLY_DIR_MODE = 0o500;
const PRIVATE_DIR_MODE = 0o700;

beforeAll(async () => { await restoreChild(); });
afterEach(cleanup);

/** The envelope fields the partial outcome promises. */
interface RestoreCliEnd { exit: number; envelope: { recoveryRequired?: boolean; marker?: string; resume?: string; refusal?: { code: string } } }

describe("a restore that stops after installation began", () => {
  it("exits 4 with recoveryRequired and the marker; the same restore then resumes", async () => {
    const root = await activated();
    const dir = await backedUp(root);
    const events = path.join(root, ".llmwiki", "indexed", "events");
    await rm(path.join(events, "manifest.json"));
    await chmod(events, READ_ONLY_DIR_MODE);
    let stopped: RestoreCliEnd;
    try {
      stopped = (await child("restore-cli", root, dir)).result as RestoreCliEnd;
    } finally {
      await chmod(events, PRIVATE_DIR_MODE);
    }
    expect([stopped.exit, stopped.envelope.recoveryRequired, stopped.envelope.marker]).toEqual([4, true, ".llmwiki/indexed-restore.json"]);
    expect(stopped.envelope.resume).toMatch(/re-run the same `llmwiki catalog restore/);
    expect(markerPresent(root)).toBe(true);
    const resumed = (await child("restore-cli", root, dir)).result as RestoreCliEnd & { envelope: { receipt?: { resumed: boolean } } };
    expect([resumed.exit, resumed.envelope.receipt?.resumed, markerPresent(root)]).toEqual([0, true, false]);
    expect(((await child("verify", root)).result as { ok: boolean }).ok).toBe(true);
  }, recoveryChainTimeoutMs);
});

describe("a backup that would omit authority", () => {
  it("of an unimported workspace catalog writes no backup index", async () => {
    const root = await activated();
    // A genuine incumbent catalog file, written by the real body in a NON-indexed scratch project, then copied in.
    const scratch = await mkdtemp(path.join(tmpdir(), "llmwiki-stray-"));
    owned.push(scratch);
    const record = createCatalogRecord({ logicalRecordId: "l-stray", mutationId: `opm_${"f".repeat(64)}`, payload: {}, createdAt: "2026-10-27T00:00:00.000Z" });
    expect(await appendCatalogRecordLocked(scratch, "stray", record)).toBe("created");
    await cp(path.join(scratch, path.dirname(legacyCatalogPath(scratch, "stray"))), path.join(root, path.dirname(legacyCatalogPath(root, "stray"))), { recursive: true });
    const dir = await mkdtemp(path.join(tmpdir(), "llmwiki-backup-"));
    owned.push(dir);
    const made = await child("backup", root, dir);
    // The incumbent gated lock refuses an unimported workspace catalog first; the backup's own omission check is
    // the second refusal. Either way no index is written.
    expect(made.outcome === "bundle-recovery-blocking" || /cannot back up/.test(String(made.message)), String(made.message)).toBe(true);
    expect(existsSync(path.join(dir, "backup.json"))).toBe(false);
  }, CHILD_CHAIN_TIMEOUT_MS);
});

/**
 * @file test/indexed/restore-cstate.test.ts
 * @description Backup and restore of a project whose segmented compile state
 * is the authority (built and restored in CHILD processes): the backup
 * carries the `cstate` store and `state.json` as its bound legacy file; a
 * corrupted compile-state segment fails verification, the restore repairs it,
 * and a fresh process then verifies every store and reads the same state.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeAll } from "../config/storage-profile-hooks.js";
import { resolveStorageTestProfile } from "../config/storage-test-profile.js";
import { backedUp, child, cleanup, compileStateProject, corruptByte, custodyChild, firstSegment, restoreChild } from "./restore-helpers.js";

/** Child chains of real durable writes on the external disk; measured, explicit. */
const CHILD_CHAIN_TIMEOUT_MS = 120_000;

/**
 * On slow external storage the cstate build took about 54 s and its backup
 * about 58 s, leaving under 10 s for restore and verification before the
 * original case limit. Give this full chain bounded headroom only under the
 * explicit slow-storage profile; normal storage and the build hook keep 120 s.
 */
const RECOVERY_CHAIN_SLOW_STORAGE_TIMEOUT_MS = 600_000;

/** The cstate recovery case's limit for the explicitly selected storage profile. */
const recoveryChainTimeoutMs = resolveStorageTestProfile(process.env.LLMWIKI_TEST_STORAGE_PROFILE).profile === "slow-durable-storage"
  ? RECOVERY_CHAIN_SLOW_STORAGE_TIMEOUT_MS
  : CHILD_CHAIN_TIMEOUT_MS;

beforeAll(async () => {
  await restoreChild();
  await custodyChild();
}, CHILD_CHAIN_TIMEOUT_MS);
afterEach(cleanup);

describe("a segmented compile state", () => {
  it("is backed up with state.json, and a corrupted segment is repaired by the restore", async () => {
    const root = await compileStateProject("restore-cstate");
    const dir = await backedUp(root);
    const index = JSON.parse(await readFile(path.join(dir, "backup.json"), "utf8")) as { stores: { store: string }[]; auxiliary: { relPath: string; state: string }[] };
    expect(index.stores.map((entry) => entry.store)).toContain("cstate");
    expect(index.auxiliary).toContainEqual(expect.objectContaining({ relPath: ".llmwiki/state.json", state: "present" }));
    expect(existsSync(path.join(dir, "tree", ".llmwiki", "state.json"))).toBe(true);
    await corruptByte(await firstSegment(root, "cstate"));
    expect(((await child("verify", root)).result as { failed: string[] }).failed).toContain("cstate");
    const restored = await child("restore", root, dir);
    expect(restored.outcome, String(restored.message)).toBe("ok");
    expect((await child("verify", root)).result).toEqual({ ok: true, failed: [] });
  }, recoveryChainTimeoutMs);
});

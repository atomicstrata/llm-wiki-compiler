/**
 * @file test/indexed/restore.test.ts
 * @description Indexed-authority backup and restore round trips on real disk,
 * every restore in a fresh child process: a corrupted segment is repaired and
 * a lost manifest re-published, after which a fresh process verifies and
 * lists. A backup refuses an unhealthy source or an in-project destination
 * and then writes no index.
 */

import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeAll } from "../config/storage-profile-hooks.js";
import { resolveStorageTestProfile } from "../config/storage-test-profile.js";
import { activated, backedUp, child, cleanup, corruptByte, firstSegment, markerPresent, restoreChild } from "./restore-helpers.js";
import { markerOwnerStale, writeRestoreMarker, type RestoreMarkerV1 } from "../../src/segments/restore-marker.js";

/**
 * These tests chain several real child processes (activate, backup, restore,
 * verify, list), each with durable writes; on the EJ8T USB disk one such chain
 * measured 27-31 s serially, so each gets an explicit, measured limit.
 */
const CHILD_CHAIN_TIMEOUT_MS = 120_000;

/**
 * These round trips use the same activation and backup helpers whose setup
 * alone reached about 121 s in the restore-refusals tests, then also restore
 * and verify. Give the two explicit round trips bounded headroom only for
 * named slow storage; normal storage and default-budget cases stay unchanged.
 */
const ROUND_TRIP_SLOW_STORAGE_TIMEOUT_MS = 600_000;

/** The explicit round-trip budget for the selected storage profile. */
const roundTripTimeoutMs = resolveStorageTestProfile(process.env.LLMWIKI_TEST_STORAGE_PROFILE).profile === "slow-durable-storage"
  ? ROUND_TRIP_SLOW_STORAGE_TIMEOUT_MS
  : CHILD_CHAIN_TIMEOUT_MS;

beforeAll(async () => { await restoreChild(); });
afterEach(cleanup);

describe("a round trip", () => {
  it("replaces a stale no-effect preflight marker with a fresh restore", async () => {
    const root = await activated();
    const dir = await backedUp(root);
    await corruptByte(await firstSegment(root, "catalog"));
    const marker: RestoreMarkerV1 = {
      format: "llmwiki-indexed-restore-marker", version: 1,
      token: "a".repeat(32), backupDigest: "b".repeat(64),
      phase: "preflight", owner: { pid: 2_147_483_647 }, journal: null,
    };
    expect(markerOwnerStale(marker)).toBe(true);
    await writeRestoreMarker(root, marker, null);
    const restored = await child("restore", root, dir);
    expect(restored.outcome, String(restored.message)).toBe("ok");
    expect((restored.result as { resumed: boolean }).resumed).toBe(false);
    expect(((await child("verify", root)).result as { ok: boolean }).ok).toBe(true);
    expect(markerPresent(root)).toBe(false);
  }, roundTripTimeoutMs);

  it("repairs a corrupted segment; a fresh process then verifies and lists", async () => {
    const root = await activated();
    const dir = await backedUp(root);
    await corruptByte(await firstSegment(root, "catalog"));
    expect(((await child("verify", root)).result as { ok: boolean }).ok).toBe(false);
    const restored = await child("restore", root, dir);
    expect(restored.outcome, String(restored.message)).toBe("ok");
    expect((restored.result as { repaired: number; resumed: boolean })).toMatchObject({ resumed: false });
    expect((restored.result as { repaired: number }).repaired).toBeGreaterThanOrEqual(1);
    expect(((await child("verify", root)).result as { ok: boolean }).ok).toBe(true);
    expect(((await child("list", root)).result as { pages: number }).pages).toBe(6);
    expect(markerPresent(root)).toBe(false);
  }, roundTripTimeoutMs);

  it("re-publishes a lost manifest", async () => {
    const root = await activated();
    const dir = await backedUp(root);
    const manifest = path.join(root, ".llmwiki", "indexed", "events", "manifest.json");
    await rename(manifest, `${manifest}.lost`);
    const restored = await child("restore", root, dir);
    expect(restored.outcome, String(restored.message)).toBe("ok");
    expect(existsSync(manifest)).toBe(true);
    expect(((await child("verify", root)).result as { ok: boolean }).ok).toBe(true);
  }, roundTripTimeoutMs);
});

describe("a backup", () => {
  it("of an unhealthy source refuses and writes no index", async () => {
    const root = await activated();
    await corruptByte(await firstSegment(root, "catalog"));
    const dir = path.join(path.dirname(root), `${path.basename(root)}-bad-backup`);
    const made = await child("backup", root, dir);
    expect(made.outcome).not.toBe("ok");
    expect(existsSync(path.join(dir, "backup.json"))).toBe(false);
  });

  it("refuses a destination inside the project", async () => {
    const root = await activated();
    const made = await child("backup", root, path.join(root, "inside-backup"));
    expect(String(made.message)).toMatch(/must be outside the project/);
  });
});

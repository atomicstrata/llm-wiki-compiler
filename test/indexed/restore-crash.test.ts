/**
 * @file test/indexed/restore-crash.test.ts
 * @description An indexed-authority restore interrupted after installing
 * files: while its owner runs, other processes AND same-process calls outside
 * its private scope refuse (`indexed_restore_in_progress`, the readiness gate
 * `scale-restore-in-progress`); once its owner is SIGKILLed, reads refuse
 * `indexed_restore_incomplete`, a different backup refuses, and re-running the
 * same restore resumes from the journal and completes.
 */

import { open } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeAll } from "../config/storage-profile-hooks.js";
import { resolveStorageTestProfile } from "../config/storage-test-profile.js";
import { childEnd, startChild } from "../helpers-child-process.js";
import { activated, backedUp, child, cleanup, firstSegment, markerPresent, owned, restoreChild } from "./restore-helpers.js";
import { waitFor } from "./gc-helpers.js";

/**
 * These tests chain several real child processes (activate, backup, restore,
 * verify, list), each with durable writes; on the EJ8T USB disk one such chain
 * measured 27-31 s serially, so each gets an explicit, measured limit.
 */
const CHILD_CHAIN_TIMEOUT_MS = 120_000;

/**
 * Activation and one backup took about 40 s and 68 s on slow external storage,
 * leaving about 12 s of the original limit before either recovery scenario's
 * restore work. The interruption case also makes a second backup. Give both
 * full chains bounded headroom only under the explicit slow-storage profile;
 * normal storage keeps the original 120 s limit and every assertion remains.
 */
const RECOVERY_CHAIN_SLOW_STORAGE_TIMEOUT_MS = 600_000;

/** The recovery cases' limit for the explicitly selected storage profile. */
const recoveryChainTimeoutMs = resolveStorageTestProfile(process.env.LLMWIKI_TEST_STORAGE_PROFILE).profile === "slow-durable-storage"
  ? RECOVERY_CHAIN_SLOW_STORAGE_TIMEOUT_MS
  : CHILD_CHAIN_TIMEOUT_MS;

beforeAll(async () => { await restoreChild(); });
afterEach(cleanup);

/** Flip one byte of the first catalog segment of `root`. */
async function corruptCatalog(root: string): Promise<void> {
  const handle = await open(await firstSegment(root, "catalog"), "r+");
  await handle.write(Buffer.from("Z"), 0, 1, 24);
  await handle.close();
}

describe("an interrupted restore", () => {
  it("refuses everyone else, then resumes to completion when re-run", async () => {
    const root = await activated();
    const dir = await backedUp(root);
    const other = await backedUp(root);
    await corruptCatalog(root);
    const paused = `${dir}.paused`;
    owned.push(paused);
    const restorer = startChild(await restoreChild(), ["restore", root, dir, paused]);
    const ended = childEnd(restorer);
    try {
      await waitFor(paused);
      expect((await child("list", root)).outcome).toBe("indexed_restore_in_progress");
    } finally {
      restorer.kill("SIGKILL");
      await ended;
    }
    expect(markerPresent(root)).toBe(true);
    expect((await child("list", root)).outcome).toBe("indexed_restore_incomplete");
    expect((await child("restore", root, other)).outcome).toBe("indexed_restore_conflict");
    const resumed = await child("restore", root, dir);
    expect(resumed.outcome, String(resumed.message)).toBe("ok");
    expect((resumed.result as { resumed: boolean }).resumed).toBe(true);
    expect(((await child("verify", root)).result as { ok: boolean }).ok).toBe(true);
    expect(markerPresent(root)).toBe(false);
  }, recoveryChainTimeoutMs);

  it("refuses same-process calls outside its private scope while it runs", async () => {
    const root = await activated();
    const dir = await backedUp(root);
    const paused = path.join(path.dirname(dir), `${path.basename(dir)}.probe`);
    owned.push(paused);
    const probed = await child("restore-probe", root, dir, paused);
    expect(probed.outcome, String(probed.message)).toBe("ok");
    expect((probed.result as { seen: Record<string, string> }).seen).toEqual({ list: "indexed_restore_in_progress", ready: "scale-restore-in-progress" });
  }, recoveryChainTimeoutMs);
});

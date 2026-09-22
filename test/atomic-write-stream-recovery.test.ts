/**
 * @file test/atomic-write-stream-recovery.test.ts
 * @description A crash in the streamed content-addressed publish window — after
 * the deterministic temp is linked to the digest name (nlink=2) and before it is
 * removed — is RECONCILED on the next attempt back to a clean single-link object
 * rather than permanently poisoning the leaf. Every post-link boundary is
 * replayable, and a foreign hardlink is rejected instead of silently reconciled.
 */

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { link, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { FileHandle } from "node:fs/promises";
import {
  atomicStreamCreateOnlyDurable, AtomicWriteCollisionError,
  AtomicWriteCommittedCleanupError, type StreamedPostLinkStageV1,
} from "../src/utils/atomic-write.js";

const CONTENT = Buffer.from("streamed-content-addressed-evidence-bytes");
const DIGEST = createHash("sha256").update(CONTENT).digest("hex");
const STAGES: StreamedPostLinkStageV1[] = ["after-link", "after-parent-fsync", "after-publish-verify"];

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

/** A fresh destination directory outside the project. */
async function destination(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llmwiki-stream-cas-"));
  roots.push(dir);
  return dir;
}

/** Stream the fixed content into the temp and report its byte count. */
async function produce(handle: FileHandle): Promise<number> {
  await handle.writeFile(CONTENT);
  return CONTENT.byteLength;
}

/** Publish the fixed content-addressed leaf, faulting at one post-link stage. */
function publish(dir: string, crashAt?: StreamedPostLinkStageV1) {
  return atomicStreamCreateOnlyDurable(dir, DIGEST, produce, crashAt === undefined ? {} : {
    streamedPostLinkFaultForTest: async (stage) => { if (stage === crashAt) throw new Error(`crash ${stage}`); },
  });
}

describe("streamed content-addressed durable publish", () => {
  it("publishes a single-link leaf and reports a plain collision on replay", async () => {
    const dir = await destination();
    const result = await publish(dir);
    const leaf = path.join(dir, DIGEST);
    expect(result).toEqual({ filename: DIGEST, byteCount: CONTENT.byteLength });
    expect((await lstat(leaf)).nlink).toBe(1);
    expect(await readFile(leaf)).toEqual(CONTENT);
    await expect(publish(dir)).rejects.toBeInstanceOf(AtomicWriteCollisionError);
    expect((await lstat(leaf)).nlink).toBe(1);
  });

  it.each(STAGES)("reconciles a crash %s back to a clean single-link object", async (stage) => {
    const dir = await destination();
    const leaf = path.join(dir, DIGEST);
    await expect(publish(dir, stage)).rejects.toThrow(`crash ${stage}`);
    expect((await lstat(leaf)).nlink).toBe(2); // poisoned: the temp is still a second link
    expect((await lstat(`${leaf}.tmp`)).isFile()).toBe(true);
    await expect(publish(dir)).rejects.toBeInstanceOf(AtomicWriteCollisionError); // retry reconciles
    expect((await lstat(leaf)).nlink).toBe(1);
    expect(await readFile(leaf)).toEqual(CONTENT);
    await expect(lstat(`${leaf}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a foreign hardlink instead of reconciling the poisoned leaf", async () => {
    const dir = await destination();
    const leaf = path.join(dir, DIGEST);
    await expect(publish(dir, "after-link")).rejects.toThrow("crash after-link");
    await link(leaf, path.join(dir, "foreign-alias")); // a third link the protocol never made
    await expect(publish(dir)).rejects.toBeInstanceOf(AtomicWriteCommittedCleanupError);
    expect((await lstat(leaf)).nlink).toBe(3); // untouched: fail closed, never silently removed
    expect(await readFile(leaf)).toEqual(CONTENT);
  });

  it("fsyncs the parent AGAIN after removing the committed temp (power-loss durable publish)", async () => {
    const dir = await destination();
    const leaf = path.join(dir, DIGEST);
    const tmpPresentAtSync: boolean[] = [];
    await atomicStreamCreateOnlyDurable(dir, DIGEST, produce, {
      beforeDirectorySyncForTest: async () => { tmpPresentAtSync.push(await lstat(`${leaf}.tmp`).then(() => true, () => false)); },
    });
    expect(tmpPresentAtSync).toEqual([true, false]); // pre-removal fsync sees the temp; the post-removal fsync does not
    expect((await lstat(leaf)).nlink).toBe(1);
  });

  it("fsyncs the parent AGAIN after reconciling a poisoned temp on retry (power-loss durable)", async () => {
    const dir = await destination();
    const leaf = path.join(dir, DIGEST);
    await expect(publish(dir, "after-link")).rejects.toThrow("crash after-link"); // poison: nlink=2, tmp present
    const tmpPresentAtSync: boolean[] = [];
    await expect(atomicStreamCreateOnlyDurable(dir, DIGEST, produce, {
      beforeDirectorySyncForTest: async () => { tmpPresentAtSync.push(await lstat(`${leaf}.tmp`).then(() => true, () => false)); },
    })).rejects.toBeInstanceOf(AtomicWriteCollisionError);
    expect(tmpPresentAtSync).toEqual([true, false]); // reconcile fsyncs before AND after removing the poisoned temp
    expect((await lstat(leaf)).nlink).toBe(1);
  });
});

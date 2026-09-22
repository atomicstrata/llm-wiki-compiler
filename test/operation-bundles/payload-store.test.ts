/**
 * @file test/operation-bundles/payload-store.test.ts
 * @description Task 4 contract tests for immutable bundle payload bytes in
 * their bundle-owned content-addressed namespace.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { link, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { writeContentAddressedBlob } from "../../src/operation-bundles/blob-store.js";
import { MAX_PAYLOAD_BYTES } from "../../src/operation-bundles/constants.js";
import { mintBundleId } from "../../src/operation-bundles/ids.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import { writePayloadCreateOnly } from "../../src/operation-bundles/payload-store.js";
import { AtomicWriteCollisionError, atomicWrite } from "../../src/utils/atomic-write.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const root = useTempRoot();

/** Return the lowercase content-address leaf name for one exact byte sequence. */
function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("payload store", () => {
  it("rejects a sibling blob before creating its namespace", async () => {
    const bytes = Buffer.from("owned"), ownedRoot = path.join(root.dir, "owned");
    const sibling = path.join(root.dir, "sibling"), file = path.join(sibling, digest(bytes));

    await expect(writeContentAddressedBlob({
      root: root.dir, bytes, digest: digest(bytes), maxBytes: bytes.byteLength, file, ownedRoot,
    })).rejects.toThrow(/owned root/i);
    await expect(stat(sibling)).rejects.toThrow(/ENOENT/i);
  });

  it("creates and exactly replays a bundle-owned payload", async () => {
    const bundleId = mintBundleId(), bytes = Buffer.from([0, 255, 1]);
    const location = { workspaceId: "research", bundleId, digest: digest(bytes) };

    await expect(writePayloadCreateOnly(root.dir, location, bytes)).resolves.toBe("created");
    await expect(writePayloadCreateOnly(root.dir, location, bytes)).resolves.toBe("same");
    expect(await readFile(operationPaths(root.dir, "research").payloadFile(bundleId, location.digest)))
      .toEqual(bytes);
  });

  it("refuses replay through a blob inode with an external alias", async () => {
    const bundleId = mintBundleId(), bytes = Buffer.from("externally aliased");
    const location = { workspaceId: "research", bundleId, digest: digest(bytes) };
    await writePayloadCreateOnly(root.dir, location, bytes);
    const file = operationPaths(root.dir, "research").payloadFile(bundleId, location.digest);
    await link(file, path.join(root.dir, "external-payload-alias"));

    await expect(writePayloadCreateOnly(root.dir, location, bytes))
      .rejects.toThrow(/link|alias|unavailable|conflict/i);
  });

  it("refuses a mismatched pre-existing content-addressed leaf", async () => {
    const bundleId = mintBundleId(), bytes = Buffer.from("expected");
    const location = { workspaceId: "research", bundleId, digest: digest(bytes) };
    const file = operationPaths(root.dir, "research").payloadFile(bundleId, location.digest);
    await mkdir(operationPaths(root.dir, "research").payloadsRoot(bundleId), { recursive: true });
    await writeFile(file, "different");

    await expect(writePayloadCreateOnly(root.dir, location, bytes)).rejects.toThrow(/payload.*conflict|byte.*digest/i);
  });

  it("rejects an individual payload over its launch cap before publication", async () => {
    const bytes = Buffer.alloc(MAX_PAYLOAD_BYTES + 1), bundleId = mintBundleId();
    const location = { workspaceId: "research", bundleId, digest: digest(bytes) };

    await expect(writePayloadCreateOnly(root.dir, location, bytes)).rejects.toThrow(/cap/i);
  });

  it("publishes a private snapshot when the caller mutates its buffer", async () => {
    const bundleId = mintBundleId(), bytes = Buffer.from("original");
    const expected = Buffer.from(bytes);
    const location = { workspaceId: "research", bundleId, digest: digest(expected) };

    const writing = writePayloadCreateOnly(root.dir, location, bytes);
    queueMicrotask(() => bytes.fill(0x78));

    await expect(writing).resolves.toBe("created");
    expect(await readFile(operationPaths(root.dir, "research").payloadFile(bundleId, location.digest)))
      .toEqual(expected);
  });

  it("completes directory durability before an exact replay succeeds", async () => {
    const bundleId = mintBundleId(), bytes = Buffer.from("durable");
    const location = { workspaceId: "research", bundleId, digest: digest(bytes) };
    const file = operationPaths(root.dir, "research").payloadFile(bundleId, location.digest);
    const failure = new Error("injected directory fsync failure");
    await expect(atomicWrite(file, bytes, {
      createOnly: true, confineRoot: root.dir, exactParent: true,
      beforeDirectorySyncForTest: async (dir) => {
        const targetExists = dir === path.dirname(file) && await stat(file).then(() => true, () => false);
        if (targetExists) throw failure;
      },
    })).rejects.toBe(failure);
    const synced: string[] = [];
    await expect(atomicWrite(file, bytes, {
      createOnly: true, confineRoot: root.dir, exactParent: true,
      beforeDirectorySyncForTest: async (dir) => { synced.push(dir); },
    })).rejects.toBeInstanceOf(AtomicWriteCollisionError);
    const chain = directoryChain(path.dirname(file), root.dir);
    // Reconcile fsyncs the chain before AND after removing the poisoned temp (the
    // removal is power-loss durable), then the collision path fsyncs it once more.
    expect(synced).toEqual([...chain, ...chain, ...chain]);
    await expect(writePayloadCreateOnly(root.dir, location, bytes)).resolves.toBe("same");
  });
});

/** Return every directory whose entry must be durable through the root. */
function directoryChain(start: string, boundary: string): string[] {
  const result = [];
  for (let current = start; ; current = path.dirname(current)) {
    result.push(current);
    if (current === boundary) return result;
  }
}

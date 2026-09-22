/**
 * @file test/operation-bundles/projection-store.test.ts
 * @description Projection authority-store tests for format-neutral sidecars,
 * exact digest observation, idempotency, and safe same-recipe replacement.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  observeProjection,
  projectionMarkerPath,
  projectionOutputPath,
  writeProjectionLocked,
  type ProjectionTarget,
} from "../../src/operation-bundles/projection-store.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { AtomicWritePostCommitError } from "../../src/utils/atomic-write.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const root = useTempRoot();
const RECIPE_DIGEST = `sha256:${"a".repeat(64)}` as const;

/** Return the canonical prefixed digest for raw projection bytes. */
function digest(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Build a complete recipe-owned projection target. */
function target(output: string, bytes: Buffer, criticality: "required" | "optional" = "required"): ProjectionTarget {
  return {
    workspaceId: "research",
    recipeId: "daily-brief",
    recipeDigest: RECIPE_DIGEST,
    output,
    outputDigest: digest(bytes),
    criticality,
  };
}

describe("projection store", () => {
  it.each([
    ["brief.md", Buffer.from("# Brief\n"), "required"],
    ["brief.json", Buffer.from('{"title":"Brief"}'), "optional"],
    ["brief.bin", Buffer.from([0, 255, 1]), "required"],
  ] as const)("writes and replays %s with a format-neutral marker", async (output, bytes, criticality) => {
    const location = target(output, bytes, criticality);

    await expect(writeProjectionLocked(root.dir, location, bytes)).resolves.toBe("created");
    await expect(writeProjectionLocked(root.dir, location, bytes)).resolves.toBe("same");
    expect(await readFile(projectionOutputPath(root.dir, location))).toEqual(bytes);

    const marker = {
      schemaVersion: 1, recipeId: location.recipeId, recipeDigest: location.recipeDigest,
      relativeOutputPath: output, outputDigest: location.outputDigest, byteCount: bytes.byteLength,
    };
    expect(await readFile(projectionMarkerPath(root.dir, location))).toEqual(canonicalBytes(marker));
    await expect(observeProjection(root.dir, location)).resolves.toEqual({ status: "same", marker });
  });

  it("replaces only output already owned by the same recipe identity", async () => {
    const oldBytes = Buffer.from("old"), nextBytes = Buffer.from("next");
    const oldTarget = target("nested/brief.md", oldBytes);
    await writeProjectionLocked(root.dir, oldTarget, oldBytes);

    const foreignRecipe = { ...oldTarget, recipeDigest: `sha256:${"c".repeat(64)}` as const };
    await expect(observeProjection(root.dir, foreignRecipe)).resolves.toMatchObject({ status: "conflict" });

    const nextTarget = target("nested/brief.md", nextBytes);
    await expect(observeProjection(root.dir, nextTarget)).resolves.toMatchObject({ status: "replaceable" });
    await expect(writeProjectionLocked(root.dir, nextTarget, nextBytes)).resolves.toBe("replaced");
    await expect(observeProjection(root.dir, nextTarget)).resolves.toMatchObject({ status: "same" });
    expect(await readFile(projectionOutputPath(root.dir, nextTarget))).toEqual(nextBytes);
  });

  it("replays exact bytes through durability after an output directory-sync fault", async () => {
    const bytes = Buffer.from("durable"), location = target("durable/brief.md", bytes);
    const outputParent = path.dirname(projectionOutputPath(root.dir, location));
    const failure = new Error("output directory sync fault");
    let outputSyncAttempts = 0;
    const observeOutputSync = async (directory: string) => {
      if (directory !== outputParent) return;
      outputSyncAttempts += 1;
      if (outputSyncAttempts === 1) throw failure;
    };

    const rejected = await writeProjectionLocked(root.dir, location, bytes, {
      beforeOutputDirectorySyncForTest: observeOutputSync,
    }).catch(error => error);
    expect(rejected).toBeInstanceOf(AtomicWritePostCommitError);
    expect(rejected.cause).toBe(failure);
    expect(await readFile(projectionOutputPath(root.dir, location))).toEqual(bytes);
    await expect(writeProjectionLocked(root.dir, location, bytes, {
      beforeOutputDirectorySyncForTest: observeOutputSync,
    })).resolves.toBe("same");
    expect(outputSyncAttempts).toBeGreaterThanOrEqual(2);
  });

  it("does not overwrite output changed after marker publication", async () => {
    const oldBytes = Buffer.from("old"), nextBytes = Buffer.from("next");
    const concurrentBytes = Buffer.from("concurrent"), oldTarget = target("race/brief.md", oldBytes);
    await writeProjectionLocked(root.dir, oldTarget, oldBytes);
    const nextTarget = target("race/brief.md", nextBytes);
    const output = projectionOutputPath(root.dir, nextTarget);

    await expect(writeProjectionLocked(root.dir, nextTarget, nextBytes, {
      afterMarkerWriteForTest: async () => writeFile(output, concurrentBytes),
    })).rejects.toThrow(/changed concurrently/i);
    expect(await readFile(output)).toEqual(concurrentBytes);
  });

  it("does not overwrite a marker changed before marker publication", async () => {
    const oldBytes = Buffer.from("old"), nextBytes = Buffer.from("next");
    const oldTarget = target("marker-race/brief.md", oldBytes);
    await writeProjectionLocked(root.dir, oldTarget, oldBytes);
    const nextTarget = target("marker-race/brief.md", nextBytes);
    const marker = projectionMarkerPath(root.dir, nextTarget);
    const concurrentMarker = Buffer.from("concurrent marker");

    await expect(writeProjectionLocked(root.dir, nextTarget, nextBytes, {
      beforeMarkerPublicationForTest: async () => writeFile(marker, concurrentMarker),
    })).rejects.toThrow(/changed concurrently/i);
    expect(await readFile(marker)).toEqual(concurrentMarker);
  });

  it("does not publish a marker when an initially absent output appears", async () => {
    const bytes = Buffer.from("intended"), concurrentBytes = Buffer.from("concurrent");
    const location = target("absent-race/brief.md", bytes);
    const marker = projectionMarkerPath(root.dir, location);
    const output = projectionOutputPath(root.dir, location);

    await expect(writeProjectionLocked(root.dir, location, bytes, {
      beforeMarkerPublicationForTest: async () => writeFile(output, concurrentBytes),
    })).rejects.toThrow(/changed concurrently/i);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(output)).toEqual(concurrentBytes);
  });

  it("distinguishes absent, conflict, and unavailable state", async () => {
    const bytes = Buffer.from("brief"), location = target("status/brief.md", bytes);
    await expect(observeProjection(root.dir, location)).resolves.toEqual({ status: "absent" });

    const output = projectionOutputPath(root.dir, location);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, bytes);
    await expect(observeProjection(root.dir, location)).resolves.toMatchObject({ status: "conflict" });

    await writeFile(projectionMarkerPath(root.dir, location), "not-json");
    await expect(observeProjection(root.dir, location)).resolves.toMatchObject({ status: "conflict" });
  });
});

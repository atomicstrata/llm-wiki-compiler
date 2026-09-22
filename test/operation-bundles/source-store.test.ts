/**
 * @file test/operation-bundles/source-store.test.ts
 * @description Task 4 contract tests for create-only retained source blobs in
 * the workspace-owned content-addressed source namespace.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MAX_RETAINED_SOURCE_BYTES } from "../../src/operation-bundles/constants.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import { writeRetainedSourceCreateOnly } from "../../src/operation-bundles/source-store.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const root = useTempRoot();

/** Return the lowercase content-address leaf name for one exact byte sequence. */
function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("retained-source store", () => {
  it("creates and exactly replays immutable workspace source bytes", async () => {
    const bytes = Buffer.from("retained source");
    const location = { workspaceId: "research", digest: digest(bytes) };

    await expect(writeRetainedSourceCreateOnly(root.dir, location, bytes)).resolves.toBe("created");
    await expect(writeRetainedSourceCreateOnly(root.dir, location, bytes)).resolves.toBe("same");
    expect(await readFile(operationPaths(root.dir, "research").sourceFile(location.digest))).toEqual(bytes);
  });

  it("fails closed when the owned source root is symlinked", async () => {
    const bytes = Buffer.from("retained source"), location = { workspaceId: "blocked", digest: digest(bytes) };
    const paths = operationPaths(root.dir, location.workspaceId);
    await mkdir(paths.workspaceRoot, { recursive: true });
    await symlink(root.dir, paths.sourcesRoot, "dir");

    await expect(writeRetainedSourceCreateOnly(root.dir, location, bytes)).rejects.toThrow(/symlink|redirect|escape/i);
  });

  it("rejects an individual retained source over its launch cap", async () => {
    const bytes = Buffer.alloc(MAX_RETAINED_SOURCE_BYTES + 1);
    const location = { workspaceId: "research", digest: digest(bytes) };

    await expect(writeRetainedSourceCreateOnly(root.dir, location, bytes)).rejects.toThrow(/cap/i);
  });
});

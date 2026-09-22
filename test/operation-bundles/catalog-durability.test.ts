/**
 * @file test/operation-bundles/catalog-durability.test.ts
 * @description Catalog durability and launch-bound tests. The logical append
 * remains a complete-file replacement, and faults or hostile files never turn
 * unreadable catalog state into permission to append.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, symlink, truncate, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  MAX_CATALOG_FILE_BYTES,
  MAX_CATALOG_RECORDS_PER_WORKSPACE,
} from "../../src/operation-bundles/constants.js";
import {
  appendCatalogRecordLocked,
  CatalogConcurrentChangeError,
  createCatalogRecord,
  readCatalogStore,
} from "../../src/operation-bundles/catalog-store.js";
import type { MutationId } from "../../src/operation-bundles/ids.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import { AtomicWritePostCommitError } from "../../src/utils/atomic-write.js";
import { makeOutsideDir } from "../fixtures/outside-dir.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const root = useTempRoot();

/** Return one valid mutation ID without depending on a bundle fixture. */
function mutation(seed: string): MutationId {
  return `opm_${createHash("sha256").update(seed).digest("hex")}`;
}

/** Build the smallest normal record used by durability cases. */
function record(seed: string, payload: unknown = { value: seed }) {
  return createCatalogRecord({
    logicalRecordId: `record-${seed}`,
    mutationId: mutation(seed),
    payload,
    createdAt: "2026-07-18T00:00:00.000Z",
  });
}

/** Assert an interposed catalog append wins and the stale writer refuses. */
async function expectConcurrentCatalogRefusal(
  candidate: ReturnType<typeof record>,
  concurrent: ReturnType<typeof record>,
  expected: readonly ReturnType<typeof record>[],
): Promise<void> {
  await expect(appendCatalogRecordLocked(root.dir, "research", candidate, {
    afterParentCheckForTest: async () => {
      await appendCatalogRecordLocked(root.dir, "research", concurrent);
    },
  })).rejects.toBeInstanceOf(CatalogConcurrentChangeError);
  const read = await readCatalogStore(root.dir, "research");
  expect(read.status === "ok" ? read.records : []).toEqual(expected);
}

describe("catalog durability", () => {
  it("recovers an exact replay after committed directory-sync failure", async () => {
    const candidate = record("durable"), failure = new Error("directory sync fault");
    const rejected = await appendCatalogRecordLocked(root.dir, "research", candidate, {
      beforeDirectorySyncForTest: async (dir) => {
        if (dir === operationPaths(root.dir, "research").workspaceRoot) throw failure;
      },
    }).catch(error => error);
    expect(rejected).toBeInstanceOf(AtomicWritePostCommitError);
    expect(rejected.cause).toBe(failure);

    await expect(appendCatalogRecordLocked(root.dir, "research", candidate)).resolves.toBe("same");
    const read = await readCatalogStore(root.dir, "research");
    expect(read.status === "ok" ? read.records : []).toEqual([candidate]);
  });

  it("rejects an oversized canonical record without creating a catalog", async () => {
    expect(() => record("large", { body: "x".repeat(64 * 1024) })).toThrow(/record.*cap/i);
    await expect(readFile(operationPaths(root.dir, "research").catalogFile)).rejects.toThrow(/ENOENT/i);
  });

  it("classifies record-count and whole-file overflow without parsing hostile content", async () => {
    const paths = operationPaths(root.dir, "research");
    await mkdir(paths.workspaceRoot, { recursive: true });
    const denseLines = Buffer.alloc(MAX_CATALOG_RECORDS_PER_WORKSPACE + 1, "\n");
    await writeFile(paths.catalogFile, Buffer.concat([denseLines, Buffer.from([0xff])]));
    const countOverflow = await readCatalogStore(root.dir, "research");
    expect(countOverflow).toMatchObject({ status: "invalid" });
    expect(countOverflow.status === "invalid" ? countOverflow.detail : "").toMatch(/record.*cap/i);

    await truncate(paths.catalogFile, MAX_CATALOG_FILE_BYTES + 1);
    await expect(readCatalogStore(root.dir, "research")).resolves.toMatchObject({ status: "unavailable" });
  });

  it("refuses a catalog whose workspace namespace redirects elsewhere", async () => {
    const paths = operationPaths(root.dir, "redirected");
    await mkdir(paths.workspacesRoot, { recursive: true });
    await symlink(root.dir, paths.workspaceRoot, "dir");

    await expect(appendCatalogRecordLocked(root.dir, "redirected", record("blocked")))
      .rejects.toThrow(/unavailable|redirect|symlink|escape/i);
  });

  it("detects a workspace-parent swap before publishing the replacement", async () => {
    const paths = operationPaths(root.dir, "swapped"), moved = `${paths.workspaceRoot}-moved`;
    const victim = await makeOutsideDir();
    await expect(appendCatalogRecordLocked(root.dir, "swapped", record("swap"), {
      afterParentCheckForTest: async () => {
        await rename(paths.workspaceRoot, moved);
        await symlink(victim, paths.workspaceRoot, "dir");
      },
    })).rejects.toThrow(/changed|redirect|symlink|escape|bound/i);
    expect(await readdir(victim)).toEqual([]);
  });

  it("refuses an exact existing catalog change before publication", async () => {
    const base = record("base"), candidate = record("candidate"), concurrent = record("concurrent");
    await appendCatalogRecordLocked(root.dir, "research", base);
    await expectConcurrentCatalogRefusal(candidate, concurrent, [base, concurrent]);
  });

  it("refuses an absent catalog created before publication", async () => {
    const candidate = record("candidate"), concurrent = record("concurrent");
    await expectConcurrentCatalogRefusal(candidate, concurrent, [concurrent]);
  });
});

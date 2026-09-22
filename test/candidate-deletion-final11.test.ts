/**
 * @file test/candidate-deletion-final11.test.ts
 * @description Decision 20 deletion regressions require distinct literal
 * namespaces and exact receipt retention from selection through unlink.
 */

import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteCandidate,
  deleteCandidateBySlug,
  writeCandidate,
  type CandidateDraft,
  type FreshCandidateWriteOptions,
} from "../src/compiler/candidates.js";
import { CandidateCustodyUnavailableError } from "../src/compiler/candidate-custody.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();
const REPLACEMENT = "UNRELATED-REPLACEMENT";

interface DeletionTestHooks {
  afterCustodyForTest?: (fileId: string) => Promise<void>;
  afterCandidateDeleteForTest?: (fileId: string, index: number) => Promise<void>;
}

type DeleteWithHooks = (root: string, id: string, hooks?: DeletionTestHooks) => Promise<boolean>;
type DeleteSlugWithHooks = (root: string, slug: string, hooks?: DeletionTestHooks) => Promise<boolean>;
type WriteWithHooks = (
  root: string,
  draft: CandidateDraft,
  options?: FreshCandidateWriteOptions & DeletionTestHooks,
) => ReturnType<typeof writeCandidate>;

/** One target-sharing candidate record with deterministic selection order. */
function candidateRecord(id: string, generatedAt: string, body = id): string {
  return JSON.stringify({
    id, title: "Shared", slug: "shared", summary: "", sources: [], body,
    generatedAt, reviewMode: "forced", heldReasons: [],
  });
}

/** Plant one deterministic pending candidate and return its absolute leaf. */
async function plant(id: string, order: number): Promise<string> {
  const dir = path.join(root.dir, ".llmwiki", "candidates");
  await mkdir(dir, { recursive: true });
  const leaf = path.join(dir, `${id}.json`);
  await writeFile(leaf, candidateRecord(id, `2026-01-01T00:00:0${order}.000Z`));
  return leaf;
}

/** Replace one selected leaf after custody was captured. */
async function replaceSelected(leaf: string): Promise<void> {
  await rm(leaf);
  await writeFile(leaf, REPLACEMENT);
}

/** Minimal same-target canonical revision. */
function revisionDraft(): CandidateDraft {
  return { title: "Shared", slug: "shared", summary: "", sources: [], body: "revised" };
}

describe("Decision 20 direct candidate deletion authority", () => {
  it("refuses direct deletion when archive aliases pending", async () => {
    const leaf = await plant("direct-alias", 0);
    await symlink(".", path.join(root.dir, ".llmwiki", "candidates", "archive"));

    await expect(deleteCandidate(root.dir, "direct-alias"))
      .rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
    expect(await readFile(leaf, "utf8")).toContain("direct-alias");
  });

  it("direct deletion refuses a replacement installed after custody capture", async () => {
    const leaf = await plant("direct-replaced", 0);
    const deleting = (deleteCandidate as DeleteWithHooks)(root.dir, "direct-replaced", {
      afterCustodyForTest: async () => replaceSelected(leaf),
    });

    await expect(deleting).rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
    expect(await readFile(leaf, "utf8")).toBe(REPLACEMENT);
  });
});

describe("Decision 20 selected candidate deletion authority", () => {
  it("slug deletion preserves a later replacement after an earlier unlink", async () => {
    const first = await plant("slug-first", 0);
    const last = await plant("slug-last", 1);
    const deleting = (deleteCandidateBySlug as DeleteSlugWithHooks)(root.dir, "shared", {
      afterCandidateDeleteForTest: async (_id, index) => {
        if (index === 0) await replaceSelected(last);
      },
    });

    await expect(deleting).rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
    await expect(access(first)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(last, "utf8")).toBe(REPLACEMENT);
  });

  it("canonical cleanup preserves a later replacement after an earlier unlink", async () => {
    const canonical = await plant("canonical", 0);
    const firstDuplicate = await plant("duplicate-first", 1);
    const lastDuplicate = await plant("duplicate-last", 2);
    const writing = (writeCandidate as WriteWithHooks)(root.dir, revisionDraft(), {
      afterCandidateDeleteForTest: async (_id, index) => {
        if (index === 0) await replaceSelected(lastDuplicate);
      },
    });

    await expect(writing).rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
    expect(JSON.parse(await readFile(canonical, "utf8")).body).toBe("revised");
    await expect(access(firstDuplicate)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(lastDuplicate, "utf8")).toBe(REPLACEMENT);
  });
});

/**
 * Tests for durable pending-candidate lifecycle helpers.
 *
 * Policy-held candidates are durable state, so repeated compiles for the same
 * slug must update the pending candidate in place instead of appending a new
 * random-id JSON file each time. Also verifies that duplicate candidate files
 * for the same slug are canonicalized to exactly one file when writeCandidate
 * is called (Issue D).
 */

import { describe, it, expect } from "vitest";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import {
  deleteCandidateBySlug,
  listCandidates,
  listPendingCandidateSlugs,
  readCandidateBySlug,
  writeCandidate,
} from "../src/compiler/candidates.js";
import { listCandidateFileIds } from "../src/utils/candidate-store.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

const CANDIDATES_DIR = ".llmwiki/candidates";

function draft(slug: string, body: string) {
  return {
    title: slug,
    slug,
    summary: `Summary for ${slug}.`,
    sources: ["source.md"],
    body,
  };
}

describe("pending candidate lifecycle", () => {
  it("supersedes an existing slug while preserving candidate id", async () => {
    const first = await writeCandidate(root.dir, draft("topic", "first body"));
    const second = await writeCandidate(root.dir, draft("topic", "second body"));
    const all = await listCandidates(root.dir);

    expect(second.id).toBe(first.id);
    expect(all).toHaveLength(1);
    expect(all[0]?.body).toBe("second body");
  });

  it("lists and deletes pending candidates by slug", async () => {
    const candidate = await writeCandidate(root.dir, draft("topic", "body"));
    expect(await readCandidateBySlug(root.dir, "topic")).toMatchObject({ id: candidate.id });
    expect(await listPendingCandidateSlugs(root.dir)).toEqual(new Set(["topic"]));

    expect(await deleteCandidateBySlug(root.dir, "topic")).toBe(true);
    expect(await readCandidateBySlug(root.dir, "topic")).toBeNull();
    expect(await deleteCandidateBySlug(root.dir, "topic")).toBe(false);
  });
});

describe("duplicate slug canonicalization (Issue D)", () => {
  /** Seed two candidate files for the same slug with different ids directly to disk. */
  async function seedDuplicates(dir: string, slug: string): Promise<{ firstId: string; secondId: string }> {
    const candidatesPath = path.join(dir, CANDIDATES_DIR);
    await mkdir(candidatesPath, { recursive: true });
    const firstId = `${slug}-aaaa0001`;
    const secondId = `${slug}-bbbb0002`;
    const base = { title: slug, slug, summary: "S.", sources: ["s.md"], body: "B.",
      generatedAt: "2026-01-01T00:00:00.000Z", reviewMode: "forced",
      heldReasons: [{ code: "manual-review-requested" }] };
    await writeFile(path.join(candidatesPath, `${firstId}.json`), JSON.stringify({ ...base, id: firstId }), "utf-8");
    await writeFile(path.join(candidatesPath, `${secondId}.json`), JSON.stringify({ ...base, id: secondId }), "utf-8");
    return { firstId, secondId };
  }

  it("removes duplicate candidate files when writeCandidate is called for an existing slug", async () => {
    const { firstId } = await seedDuplicates(root.dir, "dup-slug");
    const candidatesDir = path.join(root.dir, CANDIDATES_DIR);

    // Sanity-check: two files exist before the call
    const before = await listCandidateFileIds(candidatesDir);
    expect(before.filter((id) => id.startsWith("dup-slug"))).toHaveLength(2);

    // writeCandidate should pick the canonical id and delete the extra
    const result = await writeCandidate(root.dir, draft("dup-slug", "new body"));

    const after = await listCandidateFileIds(candidatesDir);
    const remaining = after.filter((id) => id.startsWith("dup-slug"));
    expect(remaining).toHaveLength(1);
    expect(result.id).toBe(firstId);
  });

  it("listCandidates returns exactly one candidate per slug after canonicalization", async () => {
    await seedDuplicates(root.dir, "canon-slug");

    // writeCandidate triggers canonicalization
    await writeCandidate(root.dir, draft("canon-slug", "updated body"));

    const candidates = await listCandidates(root.dir);
    const forSlug = candidates.filter((c) => c.slug === "canon-slug");
    expect(forSlug).toHaveLength(1);
    expect(forSlug[0]?.body).toBe("updated body");
  });

  it("preserves the earliest id (canonical) when duplicates exist", async () => {
    const { firstId } = await seedDuplicates(root.dir, "early-slug");

    await writeCandidate(root.dir, draft("early-slug", "body"));

    const found = await readCandidateBySlug(root.dir, "early-slug");
    expect(found?.id).toBe(firstId);
  });
});


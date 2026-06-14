/**
 * Durability tests for candidate persistence — Finding 2 & 3 from PR #97.
 *
 * Finding 2 (High): sanitizeCandidate must validate sourceStates at read time
 * so that malformed candidate JSON can never corrupt .llmwiki/state.json on
 * approval. Invalid entries (non-string hash, non-array concepts, path-traversal
 * keys) are dropped; valid entries survive and still write normally.
 *
 * Finding 3 (Medium): deleteCandidateBySlug must delete ALL candidate files for
 * a given slug, not just the first match. When duplicates exist (e.g. legacy or
 * hand-dropped files) the direct-write reconcile path must leave zero remaining
 * candidate files for that slug.
 */

import { describe, it, expect } from "vitest";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import {
  deleteCandidateBySlug,
  listCandidates,
  readCandidate,
} from "../src/compiler/candidates.js";
import { listCandidateFileIds } from "../src/utils/candidate-store.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

const CANDIDATES_DIR = ".llmwiki/candidates";

/** Write a raw object as JSON directly into the candidates dir (bypassing validation). */
async function seedRawCandidate(dir: string, filename: string, content: object): Promise<void> {
  const candidatesPath = path.join(dir, CANDIDATES_DIR);
  await mkdir(candidatesPath, { recursive: true });
  await writeFile(path.join(candidatesPath, filename), JSON.stringify(content), "utf-8");
}

/** Minimal valid base for candidate JSON seeded directly to disk. */
function baseCandidate(id: string, slug: string): object {
  return {
    id,
    title: slug,
    slug,
    summary: "S.",
    sources: ["source.md"],
    body: "B.",
    generatedAt: "2026-01-01T00:00:00.000Z",
    reviewMode: "forced",
    heldReasons: [{ code: "manual-review-requested" }],
  };
}

/** Seed N candidate files for the same slug with distinct ids. */
async function seedNDuplicates(dir: string, slug: string, count: number): Promise<string[]> {
  const suffixes = ["aaaa0001", "bbbb0002", "cccc0003"];
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${slug}-${suffixes[i]}`;
    await seedRawCandidate(dir, `${id}.json`, { ...baseCandidate(id, slug) });
    ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Finding 2: sourceStates validation in sanitizeCandidate
// ---------------------------------------------------------------------------

/**
 * Helper: seed a candidate with a single sourceStates entry where one field
 * is invalid, read it back, and assert the entry was dropped.
 */
async function assertSourceStateEntryDropped(
  dir: string,
  id: string,
  slug: string,
  invalidEntry: Record<string, unknown>,
): Promise<void> {
  await seedRawCandidate(dir, `${id}.json`, {
    ...baseCandidate(id, slug),
    sourceStates: { "source.md": invalidEntry },
  });
  const candidate = await readCandidate(dir, id);
  expect(candidate).not.toBeNull();
  expect(candidate?.sourceStates?.["source.md"]).toBeUndefined();
}

describe("Finding 2 — sourceStates validation at candidate read time", () => {
  it("drops sourceState entry whose hash is not a string", async () => {
    await assertSourceStateEntryDropped(root.dir, "bad-hash-cand", "bad-hash", {
      hash: 12345,
      concepts: ["bad-hash"],
      compiledAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("drops sourceState entry whose concepts is not an array", async () => {
    await assertSourceStateEntryDropped(root.dir, "bad-concepts-cand", "bad-concepts", {
      hash: "abc123",
      concepts: "not-an-array",
      compiledAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("drops sourceState entry whose compiledAt is not a string", async () => {
    await assertSourceStateEntryDropped(root.dir, "bad-compiledat-cand", "bad-compiledat", {
      hash: "abc123",
      concepts: ["slug"],
      compiledAt: 99999,
    });
  });

  it("drops sourceState entry with a path-traversal key (../evil.md)", async () => {
    const id = "traversal-key-cand";
    await seedRawCandidate(root.dir, `${id}.json`, {
      ...baseCandidate(id, "traversal-key"),
      sourceStates: {
        "../evil.md": { hash: "abc123", concepts: ["slug"], compiledAt: "2026-01-01T00:00:00.000Z" },
      },
    });
    const candidate = await readCandidate(root.dir, id);
    expect(candidate).not.toBeNull();
    expect(candidate?.sourceStates?.["../evil.md"]).toBeUndefined();
  });

  it("drops sourceState entry with a path-separator key (dir/source.md)", async () => {
    const id = "sep-key-cand";
    await seedRawCandidate(root.dir, `${id}.json`, {
      ...baseCandidate(id, "sep-key"),
      sourceStates: {
        "dir/source.md": { hash: "abc123", concepts: ["slug"], compiledAt: "2026-01-01T00:00:00.000Z" },
      },
    });
    const candidate = await readCandidate(root.dir, id);
    expect(candidate).not.toBeNull();
    expect(candidate?.sourceStates?.["dir/source.md"]).toBeUndefined();
  });

  it("keeps a fully valid sourceState entry after read", async () => {
    const id = "valid-state-cand";
    await seedRawCandidate(root.dir, `${id}.json`, {
      ...baseCandidate(id, "valid-state"),
      sourceStates: {
        "source.md": { hash: "abc123", concepts: ["valid-state"], compiledAt: "2026-01-01T00:00:00.000Z" },
      },
    });
    const candidate = await readCandidate(root.dir, id);
    expect(candidate?.sourceStates?.["source.md"]).toEqual({
      hash: "abc123",
      concepts: ["valid-state"],
      compiledAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("treats sourceStates as absent when the field is not an object", async () => {
    const id = "non-object-states-cand";
    await seedRawCandidate(root.dir, `${id}.json`, {
      ...baseCandidate(id, "non-object-states"),
      sourceStates: "not-an-object",
    });
    const candidate = await readCandidate(root.dir, id);
    expect(candidate).not.toBeNull();
    expect(candidate?.sourceStates).not.toBe("not-an-object");
    if (candidate?.sourceStates !== undefined) {
      expect(typeof candidate.sourceStates).toBe("object");
      expect(Object.keys(candidate.sourceStates)).toHaveLength(0);
    }
  });

  it("valid entry survives while bad entry is dropped in same candidate", async () => {
    const id = "mixed-states-cand";
    await seedRawCandidate(root.dir, `${id}.json`, {
      ...baseCandidate(id, "mixed-states"),
      sourceStates: {
        "bad.md": { hash: 99999, concepts: [id], compiledAt: "2026-01-01T00:00:00.000Z" },
        "good.md": { hash: "goodhash", concepts: [id], compiledAt: "2026-01-01T00:00:00.000Z" },
      },
    });
    const candidate = await readCandidate(root.dir, id);
    expect(candidate?.sourceStates?.["bad.md"]).toBeUndefined();
    expect(candidate?.sourceStates?.["good.md"]?.hash).toBe("goodhash");
    // Only good.md reaches approval — bad.md can never corrupt state.json
    expect(Object.keys(candidate?.sourceStates ?? {})).not.toContain("bad.md");
    expect(Object.keys(candidate?.sourceStates ?? {})).toContain("good.md");
  });

  it("path-traversal key is absent from sourceStates alongside a valid key", async () => {
    const badId = "mixed-traversal-cand";
    const goodId = "mixed-good-cand";
    await seedRawCandidate(root.dir, `${badId}.json`, {
      ...baseCandidate(badId, "mixed-bad"),
      sourceStates: { "../escape.md": { hash: "x", concepts: [], compiledAt: "now" } },
    });
    await seedRawCandidate(root.dir, `${goodId}.json`, {
      ...baseCandidate(goodId, "mixed-good"),
      sourceStates: { "good.md": { hash: "abc", concepts: ["mixed-good"], compiledAt: "2026-01-01T00:00:00.000Z" } },
    });
    const candidates = await listCandidates(root.dir);
    const bad = candidates.find((c) => c.id === badId);
    const good = candidates.find((c) => c.id === goodId);
    expect(bad?.sourceStates?.["../escape.md"]).toBeUndefined();
    expect(good?.sourceStates?.["good.md"]?.hash).toBe("abc");
  });
});

// ---------------------------------------------------------------------------
// Finding 3: deleteCandidateBySlug must delete ALL duplicates
// ---------------------------------------------------------------------------

describe("Finding 3 — deleteCandidateBySlug deletes all duplicate files for a slug", () => {
  it("deletes both candidate files when two exist for the same slug", async () => {
    await seedNDuplicates(root.dir, "dup-delete-slug", 2);
    const candidatesDir = path.join(root.dir, CANDIDATES_DIR);
    expect((await listCandidateFileIds(candidatesDir)).filter((id) => id.startsWith("dup-delete-slug"))).toHaveLength(2);

    const deleted = await deleteCandidateBySlug(root.dir, "dup-delete-slug");
    expect(deleted).toBe(true);
    expect((await listCandidateFileIds(candidatesDir)).filter((id) => id.startsWith("dup-delete-slug"))).toHaveLength(0);
  });

  it("returns false when no candidate exists for the slug", async () => {
    const result = await deleteCandidateBySlug(root.dir, "nonexistent-slug");
    expect(result).toBe(false);
  });

  it("leaves zero candidates in listCandidates after deletion of duplicates", async () => {
    await seedNDuplicates(root.dir, "zero-after-slug", 2);
    await deleteCandidateBySlug(root.dir, "zero-after-slug");
    const remaining = await listCandidates(root.dir);
    expect(remaining.filter((c) => c.slug === "zero-after-slug")).toHaveLength(0);
  });

  it("does not affect candidates for other slugs", async () => {
    await seedNDuplicates(root.dir, "target-slug", 2);
    await seedRawCandidate(root.dir, "other-slug-aaaa9999.json", {
      ...baseCandidate("other-slug-aaaa9999", "other-slug"),
    });

    await deleteCandidateBySlug(root.dir, "target-slug");

    const remaining = await listCandidates(root.dir);
    expect(remaining.filter((c) => c.slug === "target-slug")).toHaveLength(0);
    expect(remaining.filter((c) => c.slug === "other-slug")).toHaveLength(1);
  });

  it("three duplicate files: all three are deleted", async () => {
    const slug = "triple-dup-slug";
    await seedNDuplicates(root.dir, slug, 3);
    const candidatesDir = path.join(root.dir, CANDIDATES_DIR);
    expect((await listCandidateFileIds(candidatesDir)).filter((id) => id.startsWith(slug))).toHaveLength(3);

    await deleteCandidateBySlug(root.dir, slug);

    expect((await listCandidateFileIds(candidatesDir)).filter((id) => id.startsWith(slug))).toHaveLength(0);
  });
});

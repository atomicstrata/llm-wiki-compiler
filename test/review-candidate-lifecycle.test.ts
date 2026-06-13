/**
 * Tests for durable pending-candidate lifecycle helpers.
 *
 * Policy-held candidates are durable state, so repeated compiles for the same
 * slug must update the pending candidate in place instead of appending a new
 * random-id JSON file each time.
 */

import { describe, it, expect } from "vitest";
import {
  deleteCandidateBySlug,
  listCandidates,
  listPendingCandidateSlugs,
  readCandidateBySlug,
  writeCandidate,
} from "../src/compiler/candidates.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

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


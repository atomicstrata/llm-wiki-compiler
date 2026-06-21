/**
 * @file test/candidate-identity-dedup.test.ts
 * @description Cross-entity-type candidate dedup (FIX #2 — data loss).
 *
 * Candidate duplicate detection must key on the FULL target identity
 * (target-type + slug), not slug alone. Staging `papers/foo` then `ideas/foo`
 * must persist TWO candidate files — neither silently dropped — while writing
 * the SAME `papers/foo` twice canonicalizes to one (same-type same-slug IS a
 * duplicate). A DEFAULT concepts candidate (no typed target) dedups EXACTLY as
 * before: two concepts candidates for one slug collapse to a single file.
 */

import { describe, it, expect } from "vitest";
import { listCandidates, writeCandidate } from "../src/compiler/candidates.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

/** Build a typed candidate draft for an entity type + slug. */
function typedDraft(entityType: string, slug: string, body: string) {
  return { title: slug, slug, summary: "", sources: [], body, targetEntityType: entityType };
}

/** Build a DEFAULT concepts candidate draft (no typed target). */
function conceptsDraft(slug: string, body: string) {
  return { title: slug, slug, summary: "", sources: [], body };
}

/** Write two candidate drafts in order and return every persisted candidate. */
async function writeBothThenList(
  firstDraft: Parameters<typeof writeCandidate>[1],
  secondDraft: Parameters<typeof writeCandidate>[1],
) {
  const first = await writeCandidate(root.dir, firstDraft);
  await writeCandidate(root.dir, secondDraft);
  return { first, all: await listCandidates(root.dir) };
}

/**
 * Write two drafts that share one target identity, then assert they collapse to
 * a SINGLE canonical file (same id, latest body wins).
 */
async function expectCollapsesToOne(
  firstDraft: Parameters<typeof writeCandidate>[1],
  secondDraft: Parameters<typeof writeCandidate>[1],
): Promise<void> {
  const { first, all } = await writeBothThenList(firstDraft, secondDraft);
  expect(all).toHaveLength(1);
  expect(all[0]?.id).toBe(first.id);
  expect(all[0]?.body).toBe(secondDraft.body);
}

describe("candidate dedup keys on full target identity (FIX #2)", () => {
  it("keeps papers/foo and ideas/foo as TWO distinct candidates", async () => {
    const { all } = await writeBothThenList(
      typedDraft("papers", "foo", "paper body"),
      typedDraft("ideas", "foo", "idea body"),
    );
    expect(all).toHaveLength(2);
    const byType = Object.fromEntries(all.map((c) => [c.targetEntityType, c.body]));
    expect(byType).toEqual({ papers: "paper body", ideas: "idea body" });
  });

  it("canonicalizes the SAME papers/foo written twice to one file (same identity)", async () => {
    await expectCollapsesToOne(typedDraft("papers", "foo", "v1"), typedDraft("papers", "foo", "v2"));
  });

  it("dedups two DEFAULT concepts candidates for one slug to one file (unchanged)", async () => {
    await expectCollapsesToOne(conceptsDraft("topic", "first"), conceptsDraft("topic", "second"));
  });

  it("keeps a typed papers/foo and a default concepts foo as distinct", async () => {
    const { all } = await writeBothThenList(
      conceptsDraft("foo", "concept body"),
      typedDraft("papers", "foo", "paper body"),
    );
    expect(all).toHaveLength(2);
  });
});

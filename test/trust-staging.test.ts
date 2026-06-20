/**
 * @file test/trust-staging.test.ts
 * @description End-to-end SDK-level test for the CLP Phase-3 NON-DEFAULT entity
 * page staging loop (PR6 capstone).
 *
 * Drives `stageEntityPage` → `promoteStagedEntityPage` against the research-lite
 * non-default profile fixture and asserts the full loop:
 *  - staging a non-default entity page persists a typed candidate carrying
 *    `targetEntityType` + `trustDecision`, and returns a `StagedChange` whose
 *    target is a typed `EntityRef` (`papers/attention-is-all-you-need`);
 *  - promotion lands the body at `wiki/papers/<slug>.md` and clears the candidate;
 *  - the per-session volume bound fails CLOSED (no candidate written);
 *  - a non-slug-safe identity blocks the live mutation without escaping the root;
 *  - the DEFAULT candidate JSON shape stays clean (no typed keys) — a parity
 *    guard complementing the frozen goldens.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  stageEntityPage,
  promoteStagedEntityPage,
  UnknownEntityTypeError,
} from "../src/trust/staging.js";
import {
  DEFAULT_STAGED_WRITE_PER_SESSION,
  StagedWriteOverflowError,
} from "../src/trust/staged-change.js";
import { writeCandidate, listCandidates } from "../src/compiler/candidates.js";
import { buildResearchLiteProject, RESEARCH_LITE_PROFILE } from "./fixtures/profile-fixtures.js";

let root = "";
const SLUG = "attention-is-all-you-need";
const BODY = "---\ntitle: Attention Is All You Need\n---\n\n# Attention\n\nStaged body.\n";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "trust-staging-"));
  await buildResearchLiteProject(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Read the single candidate JSON file in the candidates dir, parsed. */
async function readOnlyCandidate(): Promise<Record<string, unknown>> {
  const dir = path.join(root, ".llmwiki/candidates");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  expect(files).toHaveLength(1);
  return JSON.parse(await readFile(path.join(dir, files[0]!), "utf8"));
}

describe("non-default entity page staging", () => {
  it("stages a typed candidate carrying the entity type + a typed EntityRef target", async () => {
    const staged = await stageEntityPage(root, {
      entityType: "papers",
      slug: SLUG,
      body: BODY,
      profile: RESEARCH_LITE_PROFILE,
      existingStagedCount: 0,
    });

    expect(staged.kind).toBe("page");
    expect(staged.target).toMatchObject({ entityType: "papers", slug: SLUG, id: `papers/${SLUG}` });
    const candidate = await readOnlyCandidate();
    expect(candidate.targetEntityType).toBe("papers");
    expect(candidate.trustDecision).toBe(staged.trustDecision);
    expect(candidate.body).toBe(BODY);
  });

  it("promotes the staged page into wiki/<entityType>/<slug>.md and clears the candidate", async () => {
    const staged = await stageEntityPage(root, {
      entityType: "papers",
      slug: SLUG,
      body: BODY,
      profile: RESEARCH_LITE_PROFILE,
      existingStagedCount: 0,
    });

    await promoteStagedEntityPage(root, staged.id);

    const page = path.join(root, "wiki/papers", `${SLUG}.md`);
    expect(await readFile(page, "utf8")).toBe(BODY);
    expect(await listCandidates(root)).toHaveLength(0);
  });

  it("fails CLOSED on the per-session volume bound, writing no candidate", async () => {
    await expect(
      stageEntityPage(root, {
        entityType: "papers",
        slug: SLUG,
        body: BODY,
        profile: RESEARCH_LITE_PROFILE,
        existingStagedCount: DEFAULT_STAGED_WRITE_PER_SESSION,
      }),
    ).rejects.toBeInstanceOf(StagedWriteOverflowError);
    expect(existsSync(path.join(root, ".llmwiki/candidates"))).toBe(false);
  });

  it("rejects an entityType not declared by the profile, writing no candidate", async () => {
    await expect(
      stageEntityPage(root, {
        entityType: "bogus",
        slug: SLUG,
        body: BODY,
        profile: RESEARCH_LITE_PROFILE,
        existingStagedCount: 0,
      }),
    ).rejects.toBeInstanceOf(UnknownEntityTypeError);
    expect(existsSync(path.join(root, ".llmwiki/candidates"))).toBe(false);
  });

  it("blocks a non-slug-safe identity without writing an escaping path", async () => {
    const staged = await stageEntityPage(root, {
      entityType: "papers",
      slug: "../evil",
      body: BODY,
      profile: RESEARCH_LITE_PROFILE,
      existingStagedCount: 0,
    });

    expect(staged.planned).toHaveLength(0);
    expect(staged.heldReasons).toContain("trust-blocked");
    expect(existsSync(path.join(root, "wiki/evil.md"))).toBe(false);
  });

  it("keeps the DEFAULT candidate JSON clean of typed keys (parity guard)", async () => {
    await writeCandidate(root, {
      title: "Plain",
      slug: "plain",
      summary: "",
      sources: [],
      body: "---\ntitle: Plain\n---\nBody.",
    });

    const candidate = await readOnlyCandidate();
    expect("targetEntityType" in candidate).toBe(false);
    expect("trustDecision" in candidate).toBe(false);
  });
});

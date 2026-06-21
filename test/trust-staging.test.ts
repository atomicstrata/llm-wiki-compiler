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
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  stageEntityPage,
  promoteStagedEntityPage,
  UnknownEntityTypeError,
  BlockedStagedWriteError,
  EntityFieldContractError,
} from "../src/trust/staging.js";
import {
  DEFAULT_STAGED_WRITE_PER_SESSION,
  StagedWriteOverflowError,
} from "../src/trust/staged-change.js";
import { ResourceLimitError } from "../src/trust/checks.js";
import { MAX_SOURCE_CHARS } from "../src/utils/constants.js";
import { writeCandidate, listCandidates, countCandidates } from "../src/compiler/candidates.js";
import { buildResearchLiteProject, RESEARCH_LITE_PROFILE } from "./fixtures/profile-fixtures.js";

let root = "";
// A FRESH slug not pre-seeded by buildResearchLiteProject, so the typed plan is
// a live `create` (a seeded slug would collide under allowOverwrite:false and
// route to stage-for-review — a blocked plan that now writes no candidate).
const SLUG = "linear-attention";
const BODY = "---\ntitle: Linear Attention\n---\n\n# Attention\n\nStaged body.\n";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "trust-staging-"));
  await buildResearchLiteProject(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Seed `count` minimal valid candidate JSON files directly to disk (each a
 * distinct slug), so {@link countCandidates} reports exactly `count` without
 * routing through the staging budget. Models a session that has already landed
 * candidates on disk.
 */
async function seedCandidatesOnDisk(count: number): Promise<void> {
  const dir = path.join(root, ".llmwiki/candidates");
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const id = `seed-${i}-abcd0000`;
    const record = {
      id, title: `t${i}`, slug: `seed-${i}`, summary: "", sources: [], body: "b",
      generatedAt: "2026-01-01T00:00:00.000Z", reviewMode: "forced",
      heldReasons: [{ code: "manual-review-requested" }],
    };
    await writeFile(path.join(dir, `${id}.json`), JSON.stringify(record), "utf8");
  }
}

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

  it("blocks a non-slug-safe identity, writing NO candidate and no escaping path", async () => {
    await expect(
      stageEntityPage(root, {
        entityType: "papers",
        slug: "../evil",
        body: BODY,
        profile: RESEARCH_LITE_PROFILE,
        existingStagedCount: 0,
      }),
    ).rejects.toBeInstanceOf(BlockedStagedWriteError);

    expect(existsSync(path.join(root, "wiki/evil.md"))).toBe(false);
    expect(existsSync(path.join(root, ".llmwiki/candidates"))).toBe(false);
  });

  it("refuses a typed page missing a required field, writing NO candidate", async () => {
    const noTitle = "---\nvenue: NeurIPS\n---\n\n# Body\n\nNo title field.\n";
    await expect(
      stageEntityPage(root, {
        entityType: "papers",
        slug: SLUG,
        body: noTitle,
        profile: RESEARCH_LITE_PROFILE,
        existingStagedCount: 0,
      }),
    ).rejects.toBeInstanceOf(EntityFieldContractError);
    expect(existsSync(path.join(root, ".llmwiki/candidates"))).toBe(false);
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

describe("per-session flood bound is derived from disk (FIX #3)", () => {
  /** Stage one papers page, returning the rejection promise (no await). */
  function stageOne(existingStagedCount: number): Promise<unknown> {
    return stageEntityPage(root, {
      entityType: "papers",
      slug: SLUG,
      body: BODY,
      profile: RESEARCH_LITE_PROFILE,
      existingStagedCount,
    });
  }

  it("rejects when the on-disk count is at the cap EVEN IF the caller passes 0", async () => {
    await seedCandidatesOnDisk(DEFAULT_STAGED_WRITE_PER_SESSION);

    await expect(stageOne(0)).rejects.toBeInstanceOf(StagedWriteOverflowError);
    // The exploit count is unchanged: no new candidate landed.
    expect(await countCandidates(root)).toBe(DEFAULT_STAGED_WRITE_PER_SESSION);
  });

  it("still stages normally when the on-disk count is under the cap", async () => {
    await seedCandidatesOnDisk(1);

    const staged = await stageOne(0);
    expect(staged).toMatchObject({ kind: "page" });
    expect(await countCandidates(root)).toBe(2);
  });
});

describe("staging length-guard runs before frontmatter parse (FIX #5)", () => {
  it("rejects an oversized all-frontmatter body with ResourceLimitError, writing no candidate", async () => {
    // All-frontmatter body > cap: the length guard must fire BEFORE yaml.load,
    // so the thrown error is ResourceLimitError, not EntityFieldContractError.
    const huge = `---\ntitle: ${"x".repeat(MAX_SOURCE_CHARS + 1)}\n---\n`;
    await expect(
      stageEntityPage(root, {
        entityType: "papers",
        slug: SLUG,
        body: huge,
        profile: RESEARCH_LITE_PROFILE,
        existingStagedCount: 0,
      }),
    ).rejects.toBeInstanceOf(ResourceLimitError);
    expect(existsSync(path.join(root, ".llmwiki/candidates"))).toBe(false);
  });
});

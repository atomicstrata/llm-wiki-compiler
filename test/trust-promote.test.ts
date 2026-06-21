/**
 * @file test/trust-promote.test.ts
 * @description Lock-safe typed promotion guards (FIX #3).
 *
 * `promoteCandidateUnderLock` (the shared routine behind both the SDK staging
 * helper and `review approve`'s typed branch) re-reads the candidate, loads +
 * validates the active profile, re-plans, applies, and deletes — ALL under one
 * held lock. These tests pin the two race/staleness guards:
 *  - concurrent-reject: the candidate vanishes between stage and promote →
 *    promote aborts cleanly, no page written;
 *  - profile-staleness: the active profile no longer declares the staged type →
 *    promote refuses (CandidateProfileError), candidate retained;
 * and the happy path: the page lands at `wiki/<entityType>/<slug>.md` and the
 * candidate is cleared.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  stageEntityPage,
  promoteStagedEntityPage,
} from "../src/trust/staging.js";
import { CandidateProfileError } from "../src/trust/promote.js";
import { ResourceLimitError } from "../src/trust/checks.js";
import { writeCandidate, deleteCandidate } from "../src/compiler/candidates.js";
import { MAX_SOURCE_CHARS, PROFILE_FILE } from "../src/utils/constants.js";
import { buildResearchLiteProject, RESEARCH_LITE_PROFILE } from "./fixtures/profile-fixtures.js";

let root = "";
const SLUG = "linear-attention";
const BODY = "---\ntitle: Linear Attention\n---\n\nBody.\n";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "trust-promote-"));
  await buildResearchLiteProject(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Stage a fresh (non-colliding) typed `papers` candidate and return its id. */
async function stage(): Promise<string> {
  const staged = await stageEntityPage(root, {
    entityType: "papers",
    slug: SLUG,
    body: BODY,
    profile: RESEARCH_LITE_PROFILE,
    existingStagedCount: 0,
  });
  return staged.id;
}

describe("lock-safe typed promotion", () => {
  it("promotes the happy path to wiki/papers/<slug>.md and clears the candidate", async () => {
    const id = await stage();
    await promoteStagedEntityPage(root, id);
    const page = path.join(root, "wiki/papers", `${SLUG}.md`);
    expect(existsSync(page)).toBe(true);
  });

  it("aborts cleanly when the candidate was rejected between stage and promote", async () => {
    const id = await stage();
    await deleteCandidate(root, id); // concurrent reject

    await expect(promoteStagedEntityPage(root, id)).rejects.toThrow(/not found/);
    expect(existsSync(path.join(root, "wiki/papers", `${SLUG}.md`))).toBe(false);
  });

  it("refuses promotion when the profile no longer declares the staged type", async () => {
    const id = await stage();
    // Rewrite the profile so `papers` is no longer a declared entity type.
    const trimmed = { ...RESEARCH_LITE_PROFILE, entities: { experiments: RESEARCH_LITE_PROFILE.entities.experiments } };
    await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(trimmed), "utf8");

    await expect(promoteStagedEntityPage(root, id)).rejects.toBeInstanceOf(CandidateProfileError);
    expect(existsSync(path.join(root, "wiki/papers", `${SLUG}.md`))).toBe(false);
  });
});

describe("promotion length-guard runs before frontmatter parse (FIX #5)", () => {
  it("rejects an oversized all-frontmatter body with ResourceLimitError, not a field-contract error", async () => {
    // All-frontmatter body > the cap: a yaml.load would burn ~1s; the length
    // guard must fire FIRST, so the error is ResourceLimitError (not parse-driven).
    const huge = `---\ntitle: ${"x".repeat(MAX_SOURCE_CHARS + 1)}\n---\n`;
    const candidate = await writeCandidate(root, {
      title: SLUG, slug: SLUG, summary: "", sources: [], body: huge,
      targetEntityType: "papers",
    });

    await expect(promoteStagedEntityPage(root, candidate.id)).rejects.toBeInstanceOf(ResourceLimitError);
    expect(existsSync(path.join(root, "wiki/papers", `${SLUG}.md`))).toBe(false);
  });
});

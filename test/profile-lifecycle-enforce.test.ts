/**
 * @file test/profile-lifecycle-enforce.test.ts
 * @description RUNTIME lifecycle-transition enforcement on the typed write path
 * (Phase 4 PR2), plus the `invalid-lifecycle-state` lint.
 *
 * Transitions FROM an existing page are exercised through the promotion path
 * (`review approve` on a typed candidate, which overwrites), since staging is for
 * NEW pages (it refuses to overwrite). Creation-into-a-state is exercised through
 * `stageEntityPage`. The lifecycle FSM under test is research-lite `ideas`
 * (`proposed → testing → tested → {validated,failed}`):
 *  - a legal transition (proposed → testing) promotes the page;
 *  - an illegal transition (proposed → validated) is REFUSED (exit 1, candidate
 *    retained, nothing written);
 *  - entering `failed` with unmet required evidence (`failureReason`) is refused;
 *  - a NEW page created directly at a declared non-initial state is allowed;
 *  - a typed page whose `status` is off the FSM surfaces an
 *    `invalid-lifecycle-state` lint finding;
 *  - a DEFAULT concepts candidate (no lifecycle) approves unchanged.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { stageEntityPage, LifecycleTransitionError } from "../src/trust/staging.js";
import { applyTypedCandidate } from "../src/trust/promote.js";
import reviewApproveCommand from "../src/commands/review-approve.js";
import { writeCandidate } from "../src/compiler/candidates.js";
import { lint } from "../src/linter/index.js";
import { PROFILE_FILE, CANDIDATES_DIR } from "../src/utils/constants.js";
import {
  buildResearchLiteProject,
  RESEARCH_LITE_PROFILE,
  writeMarkdownPage,
} from "./fixtures/profile-fixtures.js";

let root = "";
const IDEA = "sparse-routing"; // pre-seeded by buildResearchLiteProject at status: proposed

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "lifecycle-enforce-"));
  await buildResearchLiteProject(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write a typed `ideas` candidate carrying `body` and return its id. */
async function stageIdeaCandidate(body: string): Promise<string> {
  const candidate = await writeCandidate(root, {
    title: IDEA, slug: IDEA, summary: "", sources: [], body, targetEntityType: "ideas",
  });
  return candidate.id;
}

/**
 * Run a CLI command `fn` with `dir` as the cwd, console silenced, and
 * `process.exitCode` reset before/after — restoring everything in `finally`.
 * Shared so the chdir+mock boilerplate is not duplicated across tests.
 */
async function runCliInDir(dir: string, fn: () => Promise<void>): Promise<void> {
  const cwd = process.cwd();
  process.chdir(dir);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = 0;
  try {
    await fn();
  } finally {
    process.chdir(cwd);
    vi.restoreAllMocks();
    process.exitCode = 0;
  }
}

describe("runtime lifecycle enforcement — transition on promote", () => {
  it("promotes a legal transition proposed → testing", async () => {
    const candidate = { slug: IDEA, body: "---\nstatus: testing\n---\n\nTesting.\n", targetEntityType: "ideas" };
    const rel = await applyTypedCandidate(root, candidate as never);
    expect(await readFile(path.join(root, rel), "utf8")).toContain("status: testing");
  });

  it("refuses an illegal transition proposed → validated, leaving the page unchanged", async () => {
    await expect(
      applyTypedCandidate(root, { slug: IDEA, body: "---\nstatus: validated\n---\n\nSkip.\n", targetEntityType: "ideas" } as never),
    ).rejects.toBeInstanceOf(LifecycleTransitionError);
    expect(await readFile(path.join(root, "wiki/ideas", `${IDEA}.md`), "utf8")).toContain("status: proposed");
  });

  it("review approve refuses an illegal transition (exit 1, candidate retained)", async () => {
    await runCliInDir(root, async () => {
      const id = await stageIdeaCandidate("---\nstatus: validated\n---\n\nSkip.\n");
      await reviewApproveCommand(id);
      expect(process.exitCode).toBe(1);
      expect(existsSync(path.join(root, CANDIDATES_DIR, `${id}.json`))).toBe(true);
    });
  });
});

describe("runtime lifecycle enforcement — creation via staging", () => {
  it("allows creating a NEW page directly at a declared non-initial state", async () => {
    const staged = await stageEntityPage(root, {
      entityType: "ideas", slug: "fresh-idea", body: "---\nstatus: tested\n---\n\nImported.\n",
      profile: RESEARCH_LITE_PROFILE, existingStagedCount: 0,
    });
    expect(staged).toMatchObject({ kind: "page" });
  });

  it("refuses creating a NEW page at an off-FSM lifecycle value", async () => {
    // A profile whose lifecycle field is NOT enum-constrained, so the off-FSM
    // value reaches the lifecycle gate rather than the field-contract gate.
    const profile = {
      ...RESEARCH_LITE_PROFILE,
      entities: {
        ...RESEARCH_LITE_PROFILE.entities,
        ideas: { directory: "wiki/ideas", lifecycle: RESEARCH_LITE_PROFILE.entities.ideas.lifecycle },
      },
    };
    await expect(
      stageEntityPage(root, {
        entityType: "ideas", slug: "off-fsm", body: "---\nstatus: shipped\n---\n\nNope.\n",
        profile, existingStagedCount: 0,
      }),
    ).rejects.toBeInstanceOf(LifecycleTransitionError);
  });
});

/** A research-lite profile whose `ideas.failed` state requires `failureReason`. */
const REQUIREMENTS_PROFILE = {
  ...RESEARCH_LITE_PROFILE,
  entities: {
    ...RESEARCH_LITE_PROFILE.entities,
    ideas: {
      ...RESEARCH_LITE_PROFILE.entities.ideas,
      lifecycle: {
        ...RESEARCH_LITE_PROFILE.entities.ideas.lifecycle,
        transitionRequirements: { failed: ["failureReason"] },
      },
    },
  },
};

describe("runtime lifecycle enforcement — required evidence", () => {
  beforeEach(async () => {
    await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(REQUIREMENTS_PROFILE), "utf8");
    await writeMarkdownPage(root, "wiki/ideas", IDEA, "---\nstatus: tested\n---\n\nReady.\n");
  });

  it("refuses entering `failed` without the required `failureReason` evidence", async () => {
    await expect(
      applyTypedCandidate(root, { slug: IDEA, body: "---\nstatus: failed\n---\n\nNo reason.\n", targetEntityType: "ideas" } as never),
    ).rejects.toBeInstanceOf(LifecycleTransitionError);
    expect(await readFile(path.join(root, "wiki/ideas", `${IDEA}.md`), "utf8")).toContain("status: tested");
  });

  it("allows entering `failed` when the required evidence is present", async () => {
    const body = "---\nstatus: failed\nfailureReason: out of compute\n---\n\nDone.\n";
    const rel = await applyTypedCandidate(root, { slug: IDEA, body, targetEntityType: "ideas" } as never);
    expect(await readFile(path.join(root, rel), "utf8")).toContain("status: failed");
  });
});

describe("invalid-lifecycle-state lint", () => {
  it("flags an entity page whose lifecycle field value is off the FSM", async () => {
    await writeMarkdownPage(root, "wiki/ideas", "broken-state", "---\nstatus: shipped\n---\n\nOff the FSM.\n");
    const { results } = await lint(root);
    const found = results.filter((r) => r.rule === "invalid-lifecycle-state");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "warning", entityType: "ideas" });
  });

  it("emits no lifecycle finding for on-FSM pages", async () => {
    const { results } = await lint(root);
    expect(results.some((r) => r.rule === "invalid-lifecycle-state")).toBe(false);
  });
});

describe("default concepts candidate (no lifecycle) is unaffected", () => {
  it("approves a DEFAULT concepts candidate unchanged", async () => {
    const defaultRoot = await mkdtemp(path.join(os.tmpdir(), "lifecycle-default-"));
    try {
      await runCliInDir(defaultRoot, async () => {
        const candidate = await writeCandidate(defaultRoot, {
          title: "Topic", slug: "topic", summary: "", sources: [],
          body: "---\ntitle: Topic\n---\n\nConcept body.\n",
        });
        await reviewApproveCommand(candidate.id);
        expect(existsSync(path.join(defaultRoot, "wiki/concepts", "topic.md"))).toBe(true);
        expect(process.exitCode ?? 0).toBe(0);
      });
    } finally {
      await rm(defaultRoot, { recursive: true, force: true });
    }
  });
});

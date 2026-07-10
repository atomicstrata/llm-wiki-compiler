/**
 * @file test/relation-endpoint-validity.test.ts
 * @description REPRO battery for the G1 endpoint-validity audit finding: a
 * relation counts toward a gated lifecycle precondition only when its OTHER
 * endpoint is VALID EVIDENCE — an on-disk, confined page that SATISFIES its
 * entity type's field contract and (when the requirement declares
 * `otherStates`) currently sits in an allowed lifecycle state.
 *
 * Before the fix, ANY on-disk page qualified: a field-contract-violating idea,
 * or one parked in the terminal `rejected` state, wrongly admitted an
 * experiment into `complete`. These tests drive the REAL research profile
 * fixture (whose `experiments.complete` requirement declares
 * `otherStates: ["proposed", "explored", "validated"]` — every idea state
 * except the terminal `rejected`) through the live transition path, and prove
 * the read-side STANDING re-check flags the same drift after the fact.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readFile, chmod } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EntityId } from "../src/profile/types.js";
import { transitionLifecycle } from "../src/trust/lifecycle-transition.js";
import { appendRelation } from "../src/relations/store.js";
import {
  RelationPreconditionUnmetError,
  RelationPreconditionUnverifiableError,
} from "../src/relations/enforce-precondition.js";
import {
  collectStandingRelationProblems,
  LIFECYCLE_RELATION_UNMET_KIND,
} from "../src/profile/relation-standing.js";
import { installResearchProfile, RESEARCH_PROFILE } from "./fixtures/research-profile.js";
import { writeMarkdownPage } from "./fixtures/profile-fixtures.js";

const EXP = "probe";
const IDEA = "target";
/** The `complete` transition's declared evidence field (G1 is the OTHER gate). */
const EVIDENCE = { resultSummary: "Probing confirms the hypothesized effect." };

/** A contract-valid idea frontmatter block at the given lifecycle stage. */
const validIdea = (stage: string): string =>
  `title: Target Idea\nrationale: Worth testing empirically.\nstage: ${stage}`;

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rel-endpoint-validity-"));
  await installResearchProfile(root);
  await writeMarkdownPage(
    root,
    "wiki/experiments",
    EXP,
    "---\ntitle: Probe\nhypothesis: Depth correlates with abstraction.\nstage: running\n---\n\nExperiment body.\n",
  );
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** (Over)write the `target` idea page with the given frontmatter block. */
async function writeIdea(frontmatter: string): Promise<void> {
  await writeMarkdownPage(root, "wiki/ideas", IDEA, `---\n${frontmatter}\n---\n\nIdea body.\n`);
}

/** Append the `tests` edge `experiments/probe` → `ideas/target`. */
async function linkTests(): Promise<void> {
  await appendRelation(root, RESEARCH_PROFILE, {
    type: "tests",
    from: `experiments/${EXP}` as EntityId,
    to: `ideas/${IDEA}` as EntityId,
  });
}

/** Attempt the gated `running` → `complete` transition with its evidence. */
const complete = (): Promise<void> => transitionLifecycle(root, "experiments", EXP, "complete", EVIDENCE);

/** Read the experiment page's current on-disk content. */
const readExp = (): Promise<string> => readFile(path.join(root, "wiki/experiments", `${EXP}.md`), "utf8");

describe("G1 endpoint validity — write-side enforcement", () => {
  it("REPRO (a): a tests edge to an idea MISSING a required field does not admit complete", async () => {
    await writeIdea("title: Target Idea\nstage: proposed"); // no `rationale` (required) → contract violation
    await linkTests();
    await expect(complete()).rejects.toBeInstanceOf(RelationPreconditionUnmetError);
    expect(await readExp()).toContain("stage: running");
  });

  it("a tests edge to an idea with MALFORMED frontmatter does not admit complete (fails closed, not coerced to {})", async () => {
    await writeIdea("title: [unclosed\nrationale: {broken"); // unparseable YAML -> null, never {}
    await linkTests();
    await expect(complete()).rejects.toBeInstanceOf(RelationPreconditionUnmetError);
    expect(await readExp()).toContain("stage: running");
  });

  it("REPRO (b): a tests edge to a REJECTED idea does not admit complete", async () => {
    await writeIdea(validIdea("rejected")); // terminal rejected ∉ otherStates
    await linkTests();
    await expect(complete()).rejects.toBeInstanceOf(RelationPreconditionUnmetError);
    expect(await readExp()).toContain("stage: running");
  });

  it("a REJECTED-idea denial NAMES the offending endpoint and its wrong state, not a bare found 0", async () => {
    await writeIdea(validIdea("rejected"));
    await linkTests();
    const denied = await complete().catch((err: unknown) => err);
    expect(denied).toBeInstanceOf(RelationPreconditionUnmetError);
    const message = (denied as RelationPreconditionUnmetError).message;
    expect(message).toContain(`ideas/${IDEA} (state "rejected"`);
    expect(message).toContain("not in [proposed, explored, validated]");
  });

  it("a dangling-endpoint denial NAMES the missing endpoint as invalid, not a bare found 0", async () => {
    await linkTests(); // edge exists, but the `target` idea page was never written
    const denied = await complete().catch((err: unknown) => err);
    expect(denied).toBeInstanceOf(RelationPreconditionUnmetError);
    expect((denied as RelationPreconditionUnmetError).message).toContain(`ideas/${IDEA} (endpoint missing or invalid)`);
  });

  it("an endpoint page that FAULTS on read PARKS the write (unverifiable), it is not miscounted as unmet", async () => {
    if (process.getuid?.() === 0) return; // chmod 000 does not block root; skip
    await writeIdea(validIdea("validated"));
    await linkTests();
    await chmod(path.join(root, "wiki/ideas", `${IDEA}.md`), 0o000);
    try {
      await expect(complete()).rejects.toBeInstanceOf(RelationPreconditionUnverifiableError);
      expect(await readExp()).toContain("stage: running"); // healthy run parked, page UNCHANGED
    } finally {
      await chmod(path.join(root, "wiki/ideas", `${IDEA}.md`), 0o644);
    }
  });

  it("a tests edge to a VALIDATED idea admits complete", async () => {
    await writeIdea(validIdea("validated"));
    await linkTests();
    await complete();
    expect(await readExp()).toContain("stage: complete");
  });

  it("a tests edge to a PROPOSED idea admits complete", async () => {
    await writeIdea(validIdea("proposed"));
    await linkTests();
    await complete();
    expect(await readExp()).toContain("stage: complete");
  });
});

describe("G1 endpoint validity — standing (read-side) re-check", () => {
  /** Land the experiment at `complete` with a fully-qualifying idea endpoint. */
  async function landComplete(): Promise<void> {
    await writeIdea(validIdea("explored"));
    await linkTests();
    await complete();
  }

  /** The standing problems that flag THIS experiment as no longer satisfied. */
  async function standingUnmetForExp(): Promise<number> {
    const problems = await collectStandingRelationProblems(root, RESEARCH_PROFILE);
    return problems.filter(
      (p) => p.kind === LIFECYCLE_RELATION_UNMET_KIND && p.message.includes(`experiments/${EXP}`),
    ).length;
  }

  it("reports NO standing problem while the qualifying idea stays valid and non-rejected", async () => {
    await landComplete();
    expect(await standingUnmetForExp()).toBe(0);
  });

  it("flags an experiment AT complete whose sole qualifying idea became field-invalid", async () => {
    await landComplete();
    await writeIdea("title: Target Idea\nstage: explored"); // `rationale` dropped → contract violation
    expect(await standingUnmetForExp()).toBeGreaterThan(0);
  });

  it("flags an experiment AT complete whose sole qualifying idea transitioned to rejected", async () => {
    await landComplete();
    await writeIdea(validIdea("rejected"));
    expect(await standingUnmetForExp()).toBeGreaterThan(0);
  });
});

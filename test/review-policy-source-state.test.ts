/**
 * Source-state integrity tests for the review-policy feature.
 *
 * Covers three data-integrity scenarios in the live-concept recording model:
 *
 *   H1 (merge integrity): a source feeding a held page AND a live merged page
 *   must be recorded in state with the live concept slug so that a later change
 *   to the co-contributor correctly pulls the doc.md source back into the batch.
 *
 *   #4 (reject leakage): approving one candidate from a source that had multiple
 *   held concepts must add only the approved slug to state, never the rejected sibling.
 *
 *   #5 (sibling drop): when a source produces two held candidates and both are
 *   approved (in either order), both slugs must appear in state. The old deferral
 *   model dropped the first-approved slug because addApprovedSlugToSourceState was
 *   skipped while any sibling was still pending.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import os from "os";
import { compileAndReport } from "../src/compiler/index.js";
import { listCandidates } from "../src/compiler/candidates.js";
import reviewApproveCommand from "../src/commands/review-approve.js";
import reviewRejectCommand from "../src/commands/review-reject.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { readStateClassified } from "../src/utils/state.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";

/** Write a review policy config with the given hold modes into a project root. */
async function writeReviewConfig(rootDir: string, hold: string[]): Promise<void> {
  await writeFile(
    path.join(rootDir, ".llmwiki", "config.json"),
    JSON.stringify({ version: 1, review: { hold, lowConfidenceThreshold: 0.5 } }),
    "utf-8",
  );
}

/**
 * Run a review command (approve/reject) scoped to a project dir so the
 * command's cwd-based root discovery works.
 */
async function runReviewCommand(
  rootDir: string,
  fn: (id: string) => Promise<void>,
  id: string,
): Promise<void> {
  const cwd = process.cwd();
  process.chdir(rootDir);
  try {
    await fn(id);
  } finally {
    process.chdir(cwd);
  }
}

/** Create a minimal llmwiki project root with the required directory structure. */
async function makeProjectRoot(suffix: string): Promise<string> {
  const rootDir = path.join(os.tmpdir(), `llmwiki-${suffix}-${Date.now()}`);
  await mkdir(path.join(rootDir, "sources"), { recursive: true });
  await mkdir(path.join(rootDir, "wiki", "concepts"), { recursive: true });
  await mkdir(path.join(rootDir, ".llmwiki"), { recursive: true });
  return rootDir;
}

/** Set up env vars for the stubbed provider and suppress console output. */
function setupTestEnv(): void {
  process.env.LLMWIKI_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "test-key";
  vi.spyOn(console, "log").mockImplementation(() => {});
}

/** Remove env vars set by setupTestEnv. */
function teardownTestEnv(): void {
  delete process.env.LLMWIKI_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
}

// ---------------------------------------------------------------------------
// H1: merge-integrity — two-source scenario
// ---------------------------------------------------------------------------

/** Sentinel string only present in page content when doc.md is in the compile batch. */
const DOC_SENTINEL = "DOC_MD_EXCLUSIVE_CONTENT_SENTINEL";

/** Extraction JSON for doc.md: Alpha (low-conf) + Beta (high-conf). */
const DOC_EXTRACTION = JSON.stringify({
  concepts: [
    { concept: "Alpha", summary: "Alpha summary.", is_new: true, confidence: 0.2 },
    { concept: "Beta", summary: "Beta summary.", is_new: true, confidence: 0.9 },
  ],
});

/** Extraction JSON for other.md: Beta (high-conf) only. */
const OTHER_EXTRACTION = JSON.stringify({
  concepts: [{ concept: "Beta", summary: "Beta summary.", is_new: false, confidence: 0.9 }],
});

/** Stub extraction so doc.md produces Alpha+Beta and other.md produces Beta. */
function stubH1Extraction(): void {
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockImplementation(
    async (system: string) => system.includes("Other") ? OTHER_EXTRACTION : DOC_EXTRACTION,
  );
}

/** Stub page generation: include sentinel whenever doc.md context is present. */
function stubH1Generation(): void {
  vi.spyOn(AnthropicProvider.prototype, "complete").mockImplementation(
    async (system: string) =>
      system.includes("Doc") || system.includes("doc.md")
        ? `Beta page body. ${DOC_SENTINEL} ^[doc.md]`
        : "Beta page body from other source. ^[other.md]",
  );
}

describe("H1 — merge integrity: mixed-source state preserves co-contributor", () => {
  let rootDir = "";

  beforeEach(async () => {
    setupTestEnv();
    rootDir = await makeProjectRoot("h1");
    await writeFile(path.join(rootDir, "sources", "doc.md"), "# Doc\n\nDoc content about Alpha and Beta.", "utf-8");
    await writeFile(path.join(rootDir, "sources", "other.md"), "# Other\n\nOther content about Beta.", "utf-8");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    teardownTestEnv();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("records doc.md state with live concept beta so it is pulled into merged recompile", async () => {
    await writeReviewConfig(rootDir, ["low-confidence"]);
    stubH1Extraction();
    stubH1Generation();

    await compileAndReport(rootDir);

    const { state } = await readStateClassified(rootDir);
    // doc.md must be in state with live concept "beta" — not undefined (the bug).
    expect(state.sources["doc.md"]).toBeDefined();
    expect(state.sources["doc.md"]?.concepts).toContain("beta");
    expect(state.sources["doc.md"]?.concepts).not.toContain("alpha");
  });

  it("beta page lists doc.md as source after other.md changes (H1 merge guard)", async () => {
    await writeReviewConfig(rootDir, ["low-confidence"]);
    stubH1Extraction();
    stubH1Generation();
    await compileAndReport(rootDir);

    // Prerequisite: doc.md must already be in state (proven by H1 test 1).
    const { state: stateAfterFirst } = await readStateClassified(rootDir);
    expect(stateAfterFirst.sources["doc.md"]).toBeDefined();

    // Mutate other.md so a recompile is triggered.
    await writeFile(path.join(rootDir, "sources", "other.md"), "# Other\n\nOther changed content.", "utf-8");
    vi.restoreAllMocks();
    setupTestEnv();
    // Second compile: other.md changed → doc.md pulled as affected source.
    vi.spyOn(AnthropicProvider.prototype, "toolCall").mockImplementation(
      async (system: string) => system.includes("Other changed") ? OTHER_EXTRACTION : DOC_EXTRACTION,
    );
    stubH1Generation();

    await compileAndReport(rootDir);

    // doc.md must be listed in beta.md sources — it was re-merged as co-contributor.
    const betaContent = await readFile(path.join(rootDir, CONCEPTS_DIR, "beta.md"), "utf-8");
    expect(betaContent).toContain("doc.md");
  });
});

// ---------------------------------------------------------------------------
// #4: reject leakage — one source, multiple held concepts
// ---------------------------------------------------------------------------

describe("#4 — reject leakage: approving alpha does not record rejected beta", () => {
  let rootDir = "";

  beforeEach(async () => {
    setupTestEnv();
    rootDir = await makeProjectRoot("reject-leak");
    await writeFile(path.join(rootDir, "sources", "source.md"), "# Source\n\nAlpha and Beta content.", "utf-8");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    teardownTestEnv();
    await rm(rootDir, { recursive: true, force: true });
  });

  function stubBothHeld(): ReturnType<typeof vi.spyOn> {
    // Both alpha and beta are low-confidence → both held
    const extraction = JSON.stringify({
      concepts: [
        { concept: "Alpha", summary: "Alpha summary.", is_new: true, confidence: 0.2 },
        { concept: "Beta", summary: "Beta summary.", is_new: true, confidence: 0.3 },
      ],
    });
    const spy = vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(extraction);
    vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("Page body. ^[source.md]");
    return spy;
  }

  /** Compile, find the alpha and beta candidates, reject beta, approve alpha. */
  async function compileAndRejectBetaApproveAlpha(): Promise<void> {
    await compileAndReport(rootDir);
    const candidates = await listCandidates(rootDir);
    const alphaCandidate = candidates.find((c) => c.slug === "alpha");
    const betaCandidate = candidates.find((c) => c.slug === "beta");
    expect(alphaCandidate).toBeDefined();
    expect(betaCandidate).toBeDefined();
    await runReviewCommand(rootDir, reviewRejectCommand, betaCandidate!.id);
    await runReviewCommand(rootDir, reviewApproveCommand, alphaCandidate!.id);
  }

  it("after rejecting beta and approving alpha, state has alpha but not beta", async () => {
    await writeReviewConfig(rootDir, ["low-confidence"]);
    stubBothHeld();

    await compileAndRejectBetaApproveAlpha();

    const { state } = await readStateClassified(rootDir);
    expect(state.sources["source.md"]?.concepts).toContain("alpha");
    expect(state.sources["source.md"]?.concepts).not.toContain("beta");
  });

  it("after rejecting beta and approving alpha, a recompile does not re-offer beta", async () => {
    await writeReviewConfig(rootDir, ["low-confidence"]);
    const spy = stubBothHeld();

    await compileAndRejectBetaApproveAlpha();

    spy.mockRestore();
    vi.spyOn(console, "log").mockImplementation(() => {});
    // Source unchanged — beta must not re-appear
    const second = await compileAndReport(rootDir);

    expect(second.compiled).toBe(0);
    expect((second.candidates ?? []).length).toBe(0);
    const afterCandidates = await listCandidates(rootDir);
    expect(afterCandidates.some((c) => c.slug === "beta")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #5: sibling drop — both held candidates approved, both slugs must land in state
// ---------------------------------------------------------------------------

describe("#5 — sibling drop: approving two siblings from one source records both slugs", () => {
  let rootDir = "";

  beforeEach(async () => {
    setupTestEnv();
    rootDir = await makeProjectRoot("sibling-drop");
    await writeFile(
      path.join(rootDir, "sources", "topic.md"),
      "# Topic\n\nAlpha and Beta content.",
      "utf-8",
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    teardownTestEnv();
    await rm(rootDir, { recursive: true, force: true });
  });

  /** Stub extraction: topic.md produces alpha + beta, both low-confidence (held). */
  function stubBothHeld(): void {
    const extraction = JSON.stringify({
      concepts: [
        { concept: "Alpha", summary: "Alpha summary.", is_new: true, confidence: 0.2 },
        { concept: "Beta", summary: "Beta summary.", is_new: true, confidence: 0.3 },
      ],
    });
    vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(extraction);
    vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("Page body. ^[topic.md]");
  }

  /**
   * Compile topic.md and return the alpha and beta candidates.
   * Asserts both are present so callers can proceed without extra guards.
   */
  async function compileBothHeld(): Promise<{ alpha: { id: string }; beta: { id: string } }> {
    await compileAndReport(rootDir);
    const candidates = await listCandidates(rootDir);
    const alpha = candidates.find((c) => c.slug === "alpha");
    const beta = candidates.find((c) => c.slug === "beta");
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    return { alpha: alpha!, beta: beta! };
  }

  /** Assert that topic.md state contains both alpha and beta slugs. */
  async function assertBothSlugsInState(): Promise<void> {
    const { state } = await readStateClassified(rootDir);
    expect(state.sources["topic.md"]?.concepts).toContain("alpha");
    expect(state.sources["topic.md"]?.concepts).toContain("beta");
  }

  it("approve alpha then beta: state contains both slugs", async () => {
    await writeReviewConfig(rootDir, ["low-confidence"]);
    stubBothHeld();
    const { alpha, beta } = await compileBothHeld();

    await runReviewCommand(rootDir, reviewApproveCommand, alpha.id);
    await runReviewCommand(rootDir, reviewApproveCommand, beta.id);

    await assertBothSlugsInState();
  });

  it("approve beta then alpha: state contains both slugs", async () => {
    await writeReviewConfig(rootDir, ["low-confidence"]);
    stubBothHeld();
    const { alpha, beta } = await compileBothHeld();

    await runReviewCommand(rootDir, reviewApproveCommand, beta.id);
    await runReviewCommand(rootDir, reviewApproveCommand, alpha.id);

    await assertBothSlugsInState();
  });
});

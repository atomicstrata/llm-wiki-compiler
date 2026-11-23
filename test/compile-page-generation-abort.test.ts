/**
 * @file test/compile-page-generation-abort.test.ts
 * @description Witnesses that ordinary page generation stops at its first
 * FATAL page failure and settles before that failure escapes.
 *
 * The real `generatePagesPhase` runs over an in-memory project (the shared
 * `memoryStores` reads, so no disk and no fsync) with its real merge, link
 * targets, page rendering, citation normalisation, validation and policy. Only
 * the model is a test double ({@link GatedProvider}): every page call waits
 * until the test answers it.
 *
 * What is proved: after a fatal page failure no queued page makes a model call;
 * a page already in flight finishes BEFORE the phase rejects; the rejection is
 * the original thrown value by identity (the first one when two fail, and a
 * falsy one too); nothing is committed after it. On success the configured cap,
 * input-order outcomes and the recoverable `result.error` path are unchanged.
 * No unhandled rejection may occur in any case.
 */

import { describe, expect, it, vi } from "bun:test";
import { generatePagesPhase, type CommitLiveWrites } from "../src/compiler/compile-phases.js";
import type { ExtractionResult } from "../src/compiler/deps.js";
import type { PageGenerationResult } from "../src/compiler/types.js";
import { withQuiet } from "../src/utils/output.js";
import type { ReviewCandidate } from "../src/utils/types.js";
import { drainTurn, expectNoUnhandledRejections, fatal, GatedProvider } from "./helpers/gated-provider.js";
import { withProvider } from "./helpers/deterministic-provider.js";
import { memoryCompileProject, put, type Held } from "./storage/compile-memory-steps.js";

const [ALPHA, BETA, GAMMA, DELTA] = ["Alpha Ferry", "Beta Library", "Gamma Route", "Delta Timetable"];
const OFF_POLICY = { hold: ["off" as const], lowConfidenceThreshold: 0.5, treatMissingConfidenceAs: "ok" as const };

/** One extraction per concept, each from its own source, in the given order. */
function extractionsFor(concepts: string[]): ExtractionResult[] {
  return concepts.map((concept, i) => ({
    sourceFile: `s${i}.md`, sourcePath: `sources/s${i}.md`, sourceContent: `# ${concept}\n\n${concept} is fixture text.\n`,
    concepts: [{ concept, summary: `${concept} is fixture text.`, is_new: true }],
  }));
}

/**
 * The real phase over a memory project. `events` records each page that ran to
 * its live write (its candidate discard) and the phase's own settlement; the
 * discard of `failSlug`, if named, throws `undefined` instead.
 */
function runPhase(provider: GatedProvider, concepts: string[], concurrency: number, failSlug?: string) {
  const held: Held = { files: new Map(), dirs: new Set() };
  put(held, "wiki/index.md", "# Index\n");
  const events: string[] = [];
  const access = memoryCompileProject(held, {
    emitCandidate: async (draft) => ({ ...draft, id: draft.slug, generatedAt: "fixed" }) as ReviewCandidate,
    discardCandidatesForSlug: async (slug) => { if (slug === failSlug) throw undefined; events.push(`finished ${slug}`); },
  });
  const commitLive = vi.fn<CommitLiveWrites>(async (outcomes) => ({
    writtenPages: outcomes.filter(({ result }) => result.liveWrite).map(({ entry }) => entry), batchErrors: [],
  }));
  const run: Promise<PageGenerationResult> = withProvider(provider, () => withQuiet(async () => generatePagesPhase({
    access, extractions: extractionsFor(concepts), frozenSlugs: new Set(), reconciliationSlugs: new Set(),
    schema: await access.loadSchema(), options: {}, policy: OFF_POLICY, concurrency, commitLive,
  })));
  run.then(() => events.push("phase resolved"), () => events.push("phase rejected"));
  return { run, commitLive, events };
}

/** A provider whose page calls (only) are gated. */
const pagesGated = (): GatedProvider => new GatedProvider(new Set(["page"]));

expectNoUnhandledRejections();

describe("page generation after a fatal page failure", () => {
  it("makes no further model call at concurrency 1 and rejects with the original error", async () => {
    const provider = pagesGated();
    const { run, commitLive } = runPhase(provider, [ALPHA, BETA, GAMMA], 1);
    await provider.whenStarted("page", 1);
    const error = fatal("alpha");
    provider.answer("page", ALPHA, error);
    await expect(run).rejects.toBe(error);
    await drainTurn();
    expect(provider.started("page")).toEqual([ALPHA]);
    expect(commitLive).not.toHaveBeenCalled();
  });

  it("drains in-flight work before the failure escapes and skips the queue at concurrency 2", async () => {
    const provider = pagesGated();
    const { run, commitLive, events } = runPhase(provider, [ALPHA, BETA, GAMMA, DELTA], 2);
    await provider.whenStarted("page", 2);
    const error = fatal("alpha");
    provider.answer("page", ALPHA, error);
    await drainTurn();
    expect(events).toEqual([]);
    expect(provider.started("page")).toEqual([ALPHA, BETA]);
    provider.answer("page", BETA);
    await expect(run).rejects.toBe(error);
    expect(events).toEqual(["finished beta-library", "phase rejected"]);
    expect(provider.started("page")).toEqual([ALPHA, BETA]);
    expect(commitLive).not.toHaveBeenCalled();
  });
});

describe("page generation when pages fail with unusual or several errors", () => {
  it("rejects with the FIRST fatal error when two in-flight pages fail", async () => {
    const provider = pagesGated();
    const { run, commitLive } = runPhase(provider, [ALPHA, BETA, GAMMA], 2);
    await provider.whenStarted("page", 2);
    const first = fatal("beta");
    provider.answer("page", BETA, first);
    await drainTurn();
    provider.answer("page", ALPHA, fatal("alpha"));
    await expect(run).rejects.toBe(first);
    expect(provider.started("page")).toEqual([ALPHA, BETA]);
    expect(commitLive).not.toHaveBeenCalled();
  });

  it("rejects with a falsy thrown value by identity and admits nothing after it", async () => {
    const provider = pagesGated();
    const { run, commitLive } = runPhase(provider, [ALPHA, BETA], 1, "alpha-ferry");
    await provider.whenStarted("page", 1);
    provider.answer("page", ALPHA);
    await expect(run).rejects.toBeUndefined();
    await drainTurn();
    expect(provider.started("page")).toEqual([ALPHA]);
    expect(commitLive).not.toHaveBeenCalled();
  });
});

describe("page generation without a fatal failure", () => {
  it("keeps the concurrency cap and input-order outcomes when pages finish out of order", async () => {
    const provider = pagesGated();
    const { run, commitLive } = runPhase(provider, [ALPHA, BETA, GAMMA], 2);
    await provider.whenStarted("page", 2);
    await drainTurn();
    expect(provider.started("page")).toEqual([ALPHA, BETA]);
    provider.answer("page", BETA);
    await provider.whenStarted("page", 3);
    provider.answer("page", GAMMA);
    await drainTurn();
    provider.answer("page", ALPHA);
    const result = await run;
    const order = ["alpha-ferry", "beta-library", "gamma-route"];
    expect(result.pages.map((page) => page.slug)).toEqual(order);
    expect(commitLive).toHaveBeenCalledTimes(1);
    expect(commitLive.mock.calls[0]![0].map(({ entry }) => entry.slug)).toEqual(order);
    expect(result.writtenPages.map((page) => page.slug)).toEqual(order);
    expect(result.errors).toEqual([]);
  });

  it("collects a recoverable page error and keeps admitting later pages", async () => {
    const provider = pagesGated();
    const { run, commitLive } = runPhase(provider, [ALPHA, BETA], 1);
    await provider.whenStarted("page", 1);
    provider.answer("page", ALPHA, "   ");
    await provider.whenStarted("page", 2);
    provider.answer("page", BETA);
    const result = await run;
    expect(result.errors).toEqual([`Invalid page for "${ALPHA}" — failed validation`]);
    expect(commitLive).toHaveBeenCalledTimes(1);
    expect(result.writtenPages.map((page) => page.slug)).toEqual(["beta-library"]);
  });
});

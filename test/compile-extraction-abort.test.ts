/**
 * @file test/compile-extraction-abort.test.ts
 * @description Witnesses that ordinary concept extraction stops at its first
 * FATAL extraction failure and settles before that failure escapes.
 *
 * The real review-mode compile (`runReviewProposal`: change detection, the
 * extraction phase, page generation, candidate emission) runs over an
 * in-memory project through the shared `memoryStores` reads, so no disk and
 * no fsync. Only the model is a test double ({@link GatedProvider}): every
 * extraction call waits until the test answers it; page calls answer at once.
 *
 * What is proved: after a fatal extraction failure no queued source makes its
 * extraction call; a source already in flight settles BEFORE the compile
 * rejects; the rejection is the original error by identity; no page is
 * generated and no candidate emitted. An unusable (recoverable) extraction
 * keeps later sources admitted. The cap and source order of successful
 * extraction are covered by `compile-concurrency.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import type { CandidateDraft } from "../src/compiler/candidates.js";
import { runReviewProposal } from "../src/compiler/compile-phases.js";
import { withQuiet } from "../src/utils/output.js";
import type { ReviewCandidate } from "../src/utils/types.js";
import { drainTurn, expectNoUnhandledRejections, fatal, GatedProvider } from "./helpers/gated-provider.js";
import { withProvider } from "./helpers/deterministic-provider.js";
import { memoryCompileProject, put, type Held } from "./storage/compile-memory-steps.js";

const [ALPHA, BETA, GAMMA] = ["Alpha Ferry", "Beta Library", "Gamma Route"];
/** Three sources, listed (and extracted) in this order. */
const SOURCES: Readonly<Record<string, string>> = { "a.md": ALPHA, "b.md": BETA, "c.md": GAMMA };

/** The real review-mode compile over a memory project; `events` records its settlement. */
function runCompile(provider: GatedProvider, concurrency: number) {
  const held: Held = { files: new Map(), dirs: new Set() };
  put(held, "wiki/index.md", "# Index\n");
  for (const [name, title] of Object.entries(SOURCES)) put(held, `sources/${name}`, `# ${title}\n\n${title} is fixture text.\n`);
  const drafts: CandidateDraft[] = [];
  const access = memoryCompileProject(held, {
    emitCandidate: async (draft) => { drafts.push(draft); return { ...draft, id: draft.slug, generatedAt: "fixed" } as ReviewCandidate; },
    discardCandidatesForSlug: async () => {},
  });
  const events: string[] = [];
  const run = withProvider(provider, () => withQuiet(() => runReviewProposal(access, { review: true, concurrency })));
  run.then(() => events.push("resolved"), () => events.push("rejected"));
  return { run, drafts, events };
}

/** A provider whose extraction calls (only) are gated. */
const extractionsGated = (): GatedProvider => new GatedProvider(new Set(["extract"]));

expectNoUnhandledRejections();

describe("ordinary extraction after a fatal extraction failure", () => {
  it("makes no further extraction call at concurrency 1 and rejects with the original error", async () => {
    const provider = extractionsGated();
    const { run, drafts } = runCompile(provider, 1);
    await provider.whenStarted("extract", 1);
    const error = fatal("alpha");
    provider.answer("extract", ALPHA, error);
    await expect(run).rejects.toBe(error);
    await drainTurn();
    expect(provider.started("extract")).toEqual([ALPHA]);
    expect([provider.started("page"), drafts]).toEqual([[], []]);
  });

  it("settles the in-flight source before the failure escapes and skips the queue at concurrency 2", async () => {
    const provider = extractionsGated();
    const { run, drafts, events } = runCompile(provider, 2);
    await provider.whenStarted("extract", 2);
    const error = fatal("alpha");
    provider.answer("extract", ALPHA, error);
    await drainTurn();
    expect(events).toEqual([]);
    provider.answer("extract", BETA);
    await expect(run).rejects.toBe(error);
    expect(provider.started("extract")).toEqual([ALPHA, BETA]);
    expect([provider.started("page"), drafts]).toEqual([[], []]);
  });
});

describe("ordinary extraction without a fatal failure", () => {
  it("keeps admitting sources after an unusable extraction and compiles the rest", async () => {
    const provider = extractionsGated();
    const { run, drafts } = runCompile(provider, 1);
    for (const [at, title] of [ALPHA, BETA, GAMMA].entries()) {
      await provider.whenStarted("extract", at + 1);
      provider.answer("extract", title, title === ALPHA ? "no usable extraction" : undefined);
    }
    await run;
    expect(provider.started("extract")).toEqual([ALPHA, BETA, GAMMA]);
    expect(drafts.map((draft) => draft.slug)).toEqual(["beta-library", "gamma-route"]);
  });
});

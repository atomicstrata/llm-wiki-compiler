/**
 * @file src/compiler/compile-finalize.ts
 * @description Compile's TAIL: seed pages, then interlink resolution and repair,
 * the SINGLE durable state flush, the index and MOC, and the optional embeddings
 * refresh — on both the changed route and the no-source-changes route. Moved out
 * of `compiler/index.ts` unchanged in behaviour and order.
 *
 * ONE BODY, EXPLICIT STEPS. {@link seedThenFinalizeWith} and
 * {@link finalizeUnchangedCompileWith} are the bodies. They are handed
 * {@link CompileFinalizeSteps}: each member is a whole DOMAIN step of its own
 * owner (seed generation, the frozen-orphan pass, resolution, repair, the index,
 * the MOC, the embeddings drain) or the draft's single state write — none is a
 * raw storage port, and composing them does not move compile off disk. The root
 * {@link seedThenFinalize} and {@link finalizeUnchangedCompile} keep their old
 * signatures and pass {@link localCompileFinalizeSteps}, which call the
 * incumbent functions at call time with exactly their old arguments, so every
 * module spy and module mock on them still intercepts. What stays in the bodies:
 * the review/skip-seed guard, the changed and new slug sets (seed slugs folded
 * into both), the ordering resolve → repair → flush → index → MOC → embeddings,
 * the scoped-run rule for the prompt-modifier digest, the null-draft no-flush
 * rule, the slug → page-id mapping for embeddings, the status lines and the
 * stage timings.
 */

import path from "path";
import type { CompileStateDraft } from "./compile-state-draft.js";
import type { SchemaConfig } from "../schema/index.js";
import { promptModifiersDigest } from "./prompt-modifiers.js";
import { orphanUnownedFrozenPages } from "./orphan.js";
import { resolveAndApplyLinks } from "./resolver.js";
import { repairAndApplyLinks } from "./link-repair.js";
import { generateIndex } from "./indexgen.js";
import { generateMOC } from "./obsidian.js";
import { qualifiedPageId, type PageId } from "../utils/page-id.js";
import { refreshEmbeddingsDrainingPending } from "../utils/embeddings-refresh.js";
import { emptyCompileResult, type CompilePreparation } from "./compile-phases.js";
import { generateSeedPages } from "./seed-pages.js";
import * as output from "../utils/output.js";
import { CONCEPTS_DIR } from "../utils/constants.js";
import type { MergedConcept, PageGenerationResult } from "./types.js";
import type { CompileOptions, CompileResult } from "../utils/types.js";
import { timeStage } from "../utils/stage-timing.js";

/** The whole steps compile's tail composes. Each is a domain step or the draft's write; none is storage. */
export interface CompileFinalizeSteps {
  /** Materialise schema seed pages into `generation`. Local: `generateSeedPages(root, schema, generation)`. */
  seedPages(root: string, schema: SchemaConfig, generation: PageGenerationResult): Promise<void>;
  /** Orphan the frozen slugs no source owns. Local: `orphanUnownedFrozenPages(root, draft, slugs)`. */
  orphanFrozen(root: string, draft: CompileStateDraft, slugs: Set<string>): Promise<void>;
  /** Resolve and apply interlinks. Local: `resolveAndApplyLinks(root, changedSlugs, newSlugs)`. */
  resolveLinks(root: string, changedSlugs: string[], newSlugs: string[]): Promise<unknown>;
  /** Repair and apply wikilinks. Local: `repairAndApplyLinks(root)`. */
  repairLinks(root: string): Promise<unknown>;
  /** The draft's single durable write. Local: `draft.flush(root)`. */
  flushState(root: string, draft: CompileStateDraft): Promise<void>;
  /** Regenerate `wiki/index.md`. Local: `generateIndex(root)`. */
  generateIndex(root: string): Promise<void>;
  /** Regenerate the MOC. Local: `generateMOC(root)`. */
  generateMOC(root: string): Promise<void>;
  /** Drain and refresh embeddings for `changedPageIds`. Local: `refreshEmbeddingsDrainingPending(root, changedPageIds)`. */
  refreshEmbeddings(root: string, changedPageIds: PageId[]): Promise<void>;
}

/** LOCAL. The incumbent steps, called at call time with their old arguments; frozen. In no package index. */
const localCompileFinalizeSteps: CompileFinalizeSteps = Object.freeze({
  seedPages: (root: string, schema: SchemaConfig, generation: PageGenerationResult) => generateSeedPages(root, schema, generation),
  orphanFrozen: (root: string, draft: CompileStateDraft, slugs: Set<string>) => orphanUnownedFrozenPages(root, draft, slugs),
  resolveLinks: (root: string, changedSlugs: string[], newSlugs: string[]) => resolveAndApplyLinks(root, changedSlugs, newSlugs),
  repairLinks: (root: string) => repairAndApplyLinks(root),
  flushState: (root: string, draft: CompileStateDraft) => draft.flush(root),
  generateIndex: (root: string) => generateIndex(root),
  generateMOC: (root: string) => generateMOC(root),
  refreshEmbeddings: (root: string, changedPageIds: PageId[]) => refreshEmbeddingsDrainingPending(root, changedPageIds),
});

/**
 * Behavioural switches for {@link finalizeWikiWith}, named rather than positional.
 *
 * They arrive as an object because they are same-typed booleans that each
 * INVERT a behaviour: as adjacent positional parameters, transposing two of
 * them type-checks silently and the compile does the opposite of what the
 * caller asked, on paths whose whole point is that they run less than the
 * default. One flag was tolerable; a second one arriving is the signal to name
 * them rather than to add a sixth parameter.
 */
interface FinalizeFlags {
  /**
   * Refresh the embedding store after the durable state write. `false` skips it
   * entirely, including the pending-embeddings drain, for a caller that keeps
   * its own semantic index.
   *
   * Not a prompt modifier: it changes what runs AFTER pages are written, never
   * what any prompt asks for, so it must not enter the modifier digest or
   * invalidate a page that is byte-identical under it.
   */
  embeddings?: boolean;
  /**
   * The run recompiled a SUBSET by design (`refresh --stale` supplies a
   * `changeFilter`), so it must not record the prompt-modifier selection as
   * true of the whole project — see the flush below.
   */
  scoped?: boolean;
}

/**
 * The SHARED seed→finalize routing both pipeline branches use, so the seed batch
 * (in {@link generateSeedPages}) and the resolution batch (in {@link finalizeWikiWith})
 * stay routed through the executor on BOTH the normal path AND the
 * no-source-changes early-return path. Extracting it prevents the early branch
 * from drifting back to a direct write. Pass `draft = null` for the early branch
 * (no state mutations to flush).
 */
export async function seedThenFinalize(
  root: string,
  schema: SchemaConfig,
  generation: PageGenerationResult,
  options: CompileOptions,
  draft: CompileStateDraft | null,
): Promise<void> {
  return seedThenFinalizeWith(localCompileFinalizeSteps, root, schema, generation, options, draft);
}

/** THE ONE BODY of {@link seedThenFinalize}: seed pages unless reviewing or told to skip them, then finalize. */
export async function seedThenFinalizeWith(
  steps: CompileFinalizeSteps,
  root: string,
  schema: SchemaConfig,
  generation: PageGenerationResult,
  options: CompileOptions,
  draft: CompileStateDraft | null,
): Promise<void> {
  if (!options.review && !options.skipSeedPages) {
    await steps.seedPages(root, schema, generation);
  }
  await finalizeWikiWith(steps, root, draft, generation.writtenPages, generation.seedSlugs, {
    scoped: options.changeFilter !== undefined,
    embeddings: options.embeddings !== false,
  });
}

/** The parts of the preparation the no-source-changes branch reads. */
export type UnchangedCompilePreparation = Pick<CompilePreparation, "schema" | "reconciliationSlugs" | "buckets">;

/** The no-source-changes branch: seed pages and finalize still run. */
export async function finalizeUnchangedCompile(
  root: string,
  draft: CompileStateDraft,
  prep: UnchangedCompilePreparation,
  options: CompileOptions,
): Promise<CompileResult> {
  return finalizeUnchangedCompileWith(localCompileFinalizeSteps, root, draft, prep, options);
}

/** THE ONE BODY of {@link finalizeUnchangedCompile}. */
export async function finalizeUnchangedCompileWith(
  steps: CompileFinalizeSteps,
  root: string,
  draft: CompileStateDraft,
  prep: UnchangedCompilePreparation,
  options: CompileOptions,
): Promise<CompileResult> {
  output.status("✓", output.success("Nothing to compile — all sources up to date."));
  // Seed pages are cheap deterministic writes — always run them even when
  // no source files changed, so adding a seed page to schema.json takes
  // effect on the next compile without needing a source file edit.
  const hasOwnerlessFrozen = await reconcileOwnerlessFrozen(steps, root, draft, prep.reconciliationSlugs);
  const emptyGeneration: PageGenerationResult = {
    pages: [],
    writtenPages: [],
    errors: [],
    candidates: [],
    review: { held: [], forced: [] },
    seedSlugs: [],
  };
  // Ownerless frozen reconciliation mutates the draft; otherwise null keeps
  // the no-change path from rewriting state unnecessarily.
  await timeStage("compile.finalize", () => seedThenFinalizeWith(
    steps, root, prep.schema, emptyGeneration, options, hasOwnerlessFrozen ? draft : null,
  ));
  return {
    ...emptyCompileResult(),
    skipped: prep.buckets.unchanged.length,
    // Surface seed-page slugs alongside any errors so downstream
    // consumers (MCP, embeddings, programmatic callers) can see what
    // landed even on the no-source-changes early-return path.
    pages: [...emptyGeneration.seedSlugs],
    errors: emptyGeneration.errors,
  };
}

/**
 * Orphan and clear persisted frozen slugs that no source owns.
 * @returns True when the draft was mutated and must be flushed.
 */
async function reconcileOwnerlessFrozen(
  steps: CompileFinalizeSteps,
  root: string,
  draft: CompileStateDraft,
  reconciliationSlugs: ReadonlySet<string>,
): Promise<boolean> {
  if (reconciliationSlugs.size === 0) return false;
  await steps.orphanFrozen(root, draft, new Set(reconciliationSlugs));
  draft.setFrozen(new Set());
  return true;
}

/**
 * Resolve interlinks, regenerate index/MOC, refresh embeddings
 * post-write. Seed-page slugs are folded into both the changed-slug
 * set (so embeddings refresh covers them) and the new-slug set (so
 * inbound-link resolution scans existing pages for mentions of seed
 * titles). Without that, schema-declared seed pages would land on
 * disk but stay unlinked and absent from the embedding store.
 */
async function finalizeWikiWith(
  steps: CompileFinalizeSteps,
  root: string,
  draft: CompileStateDraft | null,
  pages: MergedConcept[],
  seedSlugs: string[] = [],
  flags: FinalizeFlags = {},
): Promise<void> {
  const { scoped = false, embeddings = true } = flags;
  const conceptChangedSlugs = pages.map((entry) => entry.slug);
  const conceptNewSlugs = pages
    .filter((entry) => entry.concept.is_new)
    .map((entry) => entry.slug);
  const allChangedSlugs = [...conceptChangedSlugs, ...seedSlugs];
  const allNewSlugs = [...conceptNewSlugs, ...seedSlugs];

  if (allChangedSlugs.length > 0) {
    output.status("🔗", output.info("Resolving interlinks..."));
    // Compute + apply the resolution rewrites as ONE journalled batch. compile
    // holds the project lock for its whole pipeline → the lock-free seam.
    await steps.resolveLinks(root, allChangedSlugs, allNewSlugs);
    // Resolution adds links for titles it recognises; repair fixes links the
    // model already wrote against a page whose slug is longer than the name it
    // used. Ordered after resolution so a link resolution has just created is
    // already valid and never looks repairable.
    await steps.repairLinks(root);
  }

  // SINGLE durable state write of the whole compile: the buffered draft is
  // flushed ONLY here, after resolution has committed. A crash before this
  // re-runs the whole compile from the prior on-disk state (no half-marked
  // sources). The no-source-changes early-return path passes a null draft —
  // it has no state mutations, so there is nothing to flush.
  //
  // The modifier digest is recorded HERE rather than at load, so a compile that
  // crashes mid-run leaves the previous digest on disk and the re-run still sees
  // the difference. Recording it up front would mark the run as done under the
  // new modifiers before any page was written under them.
  //
  // A SCOPED run (`refresh --stale`, which supplies a changeFilter) recompiles a
  // subset by design, so it must not record the selection as true of the whole
  // project: the sources it filtered out still carry the previous wording, and
  // advancing the digest would retire the only signal that says so. Leaving the
  // old digest costs the pages it did refresh a second regeneration on the next
  // full compile, which is the safe direction to be wrong in.
  if (draft) {
    if (!scoped) draft.setPromptModifiers(promptModifiersDigest());
    await steps.flushState(root, draft);
  }

  await steps.generateIndex(root);
  await steps.generateMOC(root);
  if (embeddings) await timeStage("compile.embeddings", () => steps.refreshEmbeddings(root, conceptPageIds(allChangedSlugs)));
}

/**
 * The qualified page ids of the changed slugs, for the embeddings refresh.
 *
 * Semantic search is a non-critical enhancement: the shared drain behind the
 * local step ({@link refreshEmbeddingsDrainingPending}, also used by `review
 * approve`) records the changed ids to a durable write-ahead marker before its
 * attempt, reconciles that marker per id afterwards, and quarantines a poison id
 * after repeated failures, so a missing key or a transient provider error is a
 * warning, never a broken build. It runs on EVERY non-review compile, including
 * the no-source-changes branch, so prior-pending ids are retried even then.
 *
 * Compile only ever writes concept-namespace pages, so changed slugs are
 * qualified under `concepts/`. Compile already holds the project lock, so the
 * drain calls the reentrancy-safe core.
 */
function conceptPageIds(changedSlugs: string[]): PageId[] {
  const conceptsNamespace = path.basename(CONCEPTS_DIR);
  return changedSlugs.map((slug) => qualifiedPageId(conceptsNamespace, slug));
}

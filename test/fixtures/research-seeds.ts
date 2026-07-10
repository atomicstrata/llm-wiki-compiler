/**
 * @file test/fixtures/research-seeds.ts
 * @description The seed DATA for the `research` profile fixture — split out of
 * `test/fixtures/research-profile.ts` (Task 1 Step 0) so neither file crosses
 * the CLAUDE.md 400-non-comment-line cap as the pack grows across CLP Phase 7
 * Slice 7.1's tasks.
 *
 * This module carries pure data, no behavior: the `SEED_PAGES` array (one
 * contract-satisfying, lifecycle-valid page per entity type — two for the
 * types the read-surface proofs range over) and the `SEED_RELATIONS` array
 * (typed relations between seeded pages, every endpoint backed by a real
 * page). The `SeedPage` shape and its writer live in the shared
 * `test/fixtures/seed-page.ts` (re-exported here for callers that already
 * import it from this module). `test/fixtures/research-profile.ts` imports
 * all three and keeps the helper functions that consume them
 * (`buildResearchProject`, `seedResearchRelations`) unchanged.
 */

import type { EntityId } from "../../src/profile/types.js";
import type { SeedPage } from "./seed-page.js";

export type { SeedPage };

/**
 * One contract-satisfying, lifecycle-valid page per entity type (two for the
 * types the read-surface proofs range over). Bodies are ≥ the empty-page floor
 * so the lint surface stays clean; `sparse-routing` carries the distinctive
 * `MixtureOfExperts` token the context-pool proof retrieves on.
 */
export const SEED_PAGES: SeedPage[] = [
  {
    directory: "wiki/papers",
    slug: "attention-is-all-you-need",
    frontmatter: "title: Attention Is All You Need\nauthors:\n  - Vaswani\n  - Shazeer\nyear: 2017\nvenue: NeurIPS\nstage: distilled\ntriageNote: Foundational transformer architecture, high priority.\ndistilledSummary: Self-attention replaces recurrence for sequence transduction.",
    body: "The transformer dispenses with recurrence and convolutions entirely, relying on self-attention.",
  },
  {
    directory: "wiki/papers",
    slug: "scaling-laws",
    frontmatter: "title: Scaling Laws for Neural Language Models\nauthors:\n  - Kaplan\nyear: 2020\nstage: triaged\ntriageNote: Empirical power-law scaling worth distilling later.",
    body: "Test loss scales as a predictable power law with model size, dataset size, and compute budget.",
  },
  {
    directory: "wiki/sources",
    slug: "transformer-reference-repo",
    frontmatter: "title: Reference Transformer Implementation\nkind: repo\nlocator: https://example.invalid/transformer\nstage: triaged",
    body: "A clean reference implementation of the transformer used to reproduce the attention results.",
  },
  {
    directory: "wiki/sources",
    slug: "backprop-lecture",
    frontmatter: "title: Backpropagation Lecture\nkind: video\nstage: imported",
    body: "A recorded lecture walking through the backpropagation algorithm and its computational graph.",
  },
  {
    directory: "wiki/ideas",
    slug: "sparse-routing",
    frontmatter: "title: Sparse Expert Routing\nrationale: Conditional computation can grow capacity without proportional compute.\nstage: explored",
    body: "MixtureOfExperts conditional computation routing activates a small subset of experts per token.",
  },
  {
    directory: "wiki/ideas",
    slug: "curriculum-pretraining",
    frontmatter: "title: Curriculum Pretraining\nrationale: Ordering data from easy to hard may speed convergence.\nstage: proposed",
    body: "Curriculum pretraining orders training examples from simple to complex to improve sample efficiency.",
  },
  {
    directory: "wiki/experiments",
    slug: "ablation-batch-size",
    frontmatter: "title: Batch Size Ablation\nhypothesis: Larger batches reduce gradient noise and stabilize training.\nresultSummary: Diminishing returns observed beyond a critical batch size.\nstage: complete",
    body: "We sweep batch size across five orders of magnitude and measure convergence speed and final loss.",
  },
  {
    directory: "wiki/experiments",
    slug: "lr-warmup-sweep",
    frontmatter: "title: Learning-Rate Warmup Sweep\nhypothesis: A longer warmup stabilizes early transformer training.\nstage: running",
    body: "We compare linear warmup schedules of varying length to characterize early-training stability.",
  },
  {
    directory: "wiki/manuscripts",
    slug: "moe-scaling-report",
    frontmatter: "title: Scaling Sparse Mixture-of-Experts Models\nabstract: We report scaling behavior of sparsely routed expert models.\nstage: drafting",
    body: "This manuscript reports the scaling behavior of sparsely activated mixture-of-experts models.",
  },
  {
    directory: "wiki/manuscripts",
    slug: "efficiency-survey",
    frontmatter: "title: A Survey of Efficient Training Methods\nabstract: We survey methods that reduce the compute cost of training.\nstage: citation-checked",
    body: "This survey catalogues techniques that reduce the wall-clock and compute cost of model training.",
  },
  {
    directory: "wiki/topics",
    slug: "efficient-training",
    frontmatter: "title: Efficient Training\ndescription: Methods that cut the compute cost of training large models.\nstage: active",
    body: "Efficient training gathers techniques that reduce the wall-clock and compute cost of model training.",
  },
  {
    directory: "wiki/research-concepts",
    slug: "self-attention",
    frontmatter: "title: Self-Attention\ndefinition: A mechanism relating positions within a single sequence to compute a representation.\nstage: established",
    body: "Self-attention relates every position in a sequence to every other to build a context-aware representation.",
  },
  {
    directory: "wiki/methods",
    slug: "gradient-checkpointing",
    frontmatter: "title: Gradient Checkpointing\nsummary: Trade compute for memory by recomputing activations in the backward pass.\nstage: validated",
    body: "Gradient checkpointing stores a subset of activations and recomputes the rest during backpropagation to save memory.",
  },
  {
    directory: "wiki/methods",
    slug: "mixed-precision",
    frontmatter: "title: Mixed-Precision Training\nsummary: Use lower-precision arithmetic with loss scaling to speed training.\nstage: validated",
    body: "Mixed-precision training runs most operations in half precision with loss scaling to preserve numerical stability.",
  },
  {
    directory: "wiki/foundations",
    slug: "imagenet-benchmark",
    frontmatter: "title: ImageNet Benchmark\nkind: benchmark\nstage: adopted",
    body: "The ImageNet benchmark is an adopted evaluation basis for large-scale visual recognition research.",
  },
  {
    directory: "wiki/people",
    slug: "ada-lovelace",
    frontmatter: "name: Ada Lovelace\naffiliation: Analytical Society\nstage: active",
    body: "A contributor credited on several of the foundational notes underpinning this research line.",
  },
  {
    directory: "wiki/reviews",
    slug: "moe-scaling-report-review",
    frontmatter: "title: Review of the MoE Scaling Report\nsummary: Solid scaling evidence; tighten the ablation discussion before submission.\nverdict: revise",
    body: "The reviewer finds the scaling evidence solid but asks for a tighter ablation discussion before submission.",
  },
  {
    directory: "wiki/research-outputs",
    slug: "moe-model-release",
    frontmatter: "title: Sparse MoE Model Release\noutputKind: model\nstage: released",
    body: "A released sparsely activated mixture-of-experts model checkpoint accompanying the scaling report.",
  },
];

/** A typed relation to seed, expressed as `<type> <fromId> -> <toId>`. */
export const SEED_RELATIONS: Array<{ type: string; from: EntityId; to: EntityId }> = [
  { type: "cites", from: "papers/attention-is-all-you-need" as EntityId, to: "sources/transformer-reference-repo" as EntityId },
  { type: "cites", from: "manuscripts/moe-scaling-report" as EntityId, to: "papers/scaling-laws" as EntityId },
  { type: "builds-on", from: "ideas/sparse-routing" as EntityId, to: "papers/attention-is-all-you-need" as EntityId },
  { type: "builds-on", from: "ideas/curriculum-pretraining" as EntityId, to: "ideas/sparse-routing" as EntityId },
  { type: "tests", from: "experiments/ablation-batch-size" as EntityId, to: "ideas/sparse-routing" as EntityId },
  { type: "challenges", from: "manuscripts/moe-scaling-report" as EntityId, to: "papers/scaling-laws" as EntityId },
  { type: "introduces-concept", from: "papers/attention-is-all-you-need" as EntityId, to: "research-concepts/self-attention" as EntityId },
  { type: "uses-concept", from: "experiments/ablation-batch-size" as EntityId, to: "research-concepts/self-attention" as EntityId },
  { type: "proposes-method", from: "papers/attention-is-all-you-need" as EntityId, to: "methods/gradient-checkpointing" as EntityId },
  { type: "extends-method", from: "methods/mixed-precision" as EntityId, to: "methods/gradient-checkpointing" as EntityId },
  { type: "supports", from: "experiments/ablation-batch-size" as EntityId, to: "ideas/sparse-routing" as EntityId },
  { type: "contradicts", from: "experiments/lr-warmup-sweep" as EntityId, to: "ideas/curriculum-pretraining" as EntityId },
  { type: "derived-from", from: "research-outputs/moe-model-release" as EntityId, to: "experiments/ablation-batch-size" as EntityId },
  { type: "addresses-gap", from: "ideas/sparse-routing" as EntityId, to: "topics/efficient-training" as EntityId },
];

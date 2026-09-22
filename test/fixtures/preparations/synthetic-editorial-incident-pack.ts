/**
 * @file test/fixtures/preparations/synthetic-editorial-incident-pack.ts
 * @description The editorial-incident synthetic preparation pack: an incident
 * desk taking a tip in, logging the complaints it fans out into, clearing them
 * at a signoff, and redrafting amendments until its docket is empty.
 *
 * DELIBERATELY DISSIMILAR TO ITS SIBLING. Not one research word appears here —
 * no discovery, no corpus, no citation, no analysis — and that is the whole
 * point of the pack: it runs the SAME mechanics as the research pack through the
 * SAME engine, so any behaviour that depended on a research word would show up
 * as this pack failing where the other passed.
 *
 * The mechanics are imported, never restated: `buildSyntheticPack` owns the
 * phase graph, the expansions, and the bounds, and this file supplies nothing
 * but names and a seed. Two hand-copied skeletons could drift into different
 * shapes while both still claimed to differ only in vocabulary; one shared
 * builder cannot. `test/preparation-synthetic-packs.test.ts` proves both halves
 * — that the vocabularies really are disjoint, and that the documents really are
 * the same shape.
 */

import {
  buildSyntheticPack, type SyntheticPack, type SyntheticPackVocabulary,
} from "./synthetic-research-pack.js";

/**
 * The incident-desk vocabulary.
 *
 * Every term is checked against the closed plan grammar as well as against the
 * research pack: `signoff` rather than a review word, `docket` rather than a
 * queue of checkpoints, because a term the grammar itself uses would show up in
 * both documents and make the disjointness claim false for a mechanical reason.
 */
const EDITORIAL_VOCABULARY: SyntheticPackVocabulary = {
  workspaceId: "newsdesk",
  knowledgeAuthorityId: "stylebook",
  operationsAuthorityId: "masthead",
  actionId: "correction",
  originPhaseId: "intake",
  originCapabilityId: "dispatch",
  fanOutPhaseId: "complaints",
  fanOutHandlerId: "logger",
  gatePhaseId: "signoff",
  repeatPhaseId: "amendments",
  repeatCapabilityId: "redraft",
  joinPhaseId: "bulletin",
  seedBindingId: "tipoff",
  originOutputBindingId: "dispatched",
  fanOutOutputBindingId: "logged",
  gateOutputBindingId: "cleared",
  repeatOutputBindingId: "redrafted",
  deficitClassId: "droppedTips",
  continuationField: "docket",
  evidenceClassId: "retractions",
};

/** The incident pack's seed document, in its own vocabulary. */
const EDITORIAL_SEED: Record<string, unknown> = { tipoff: "misquote", docket: "bulletins" };

/** The editorial-incident synthetic preparation pack. */
export const syntheticEditorialIncidentPack: SyntheticPack =
  buildSyntheticPack("editorial-incident", EDITORIAL_VOCABULARY, EDITORIAL_SEED);

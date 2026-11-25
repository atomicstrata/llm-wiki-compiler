/**
 * Generic default approval permits pending chains and links that the existing
 * post-write repair pass can resolve. This is separate from strict generated
 * answer policy and performs no writes or provider requests.
 *
 * ONE BODY. {@link genericBrokenTargetsWith} decides over {@link GenericCitationReads}
 * (the fresh citation index, then the link-resolvable pending slugs).
 * {@link genericBrokenTargets} keeps its signature and passes the incumbent root
 * readers, called when asked, so module spies and mocks still intercept;
 * {@link genericCitationReadsOver} composes the same reads from each reader's
 * existing one body over its own seam. In no package index.
 */
import { collectAnswerCitationIndex, collectAnswerCitationIndexFrom, type AnswerCitationSources } from "./answer-index.js";
import { classifyAnswerCitations } from "./answer-report.js";
import type { AnswerCitationIndex } from "./answer-types.js";
import { parseFrontmatter } from "../utils/markdown.js";
import { recognizedWikilinkTargets } from "../wiki/wikilink-tokens.js";
import { createRepairResolver } from "../compiler/link-repair.js";
import { listLinkResolvablePendingSlugs, listLinkResolvablePendingSlugsFrom } from "../compiler/candidate-read.js";
import type { LegacyLocalRecordDirs } from "../storage/legacy-local-record-dirs.js";

/** The two reads one generic check makes, in order. No member takes a project root. */
export interface GenericCitationReads {
  /** The fresh retained/pending citation index. */
  index(): Promise<AnswerCitationIndex>;
  /** The default (untyped) pending candidates' slugs the repair pass can resolve to; strict I/O. */
  pendingSlugs(): Promise<Set<string>>;
}

/** Return only broken targets that cannot resolve through production prefix repair. */
export async function genericBrokenTargets(root: string, document: string): Promise<string[]> {
  return genericBrokenTargetsWith({
    index: () => collectAnswerCitationIndex(root),
    pendingSlugs: () => listLinkResolvablePendingSlugs(root, { strictIo: true }),
  }, document);
}

/** {@link genericBrokenTargets} over {@link GenericCitationReads}: THE ONE BODY. */
export async function genericBrokenTargetsWith(reads: GenericCitationReads, document: string): Promise<string[]> {
  const body = parseFrontmatter(document).body;
  if (recognizedWikilinkTargets(body).length === 0) return [];
  const index = await reads.index();
  const pending = await reads.pendingSlugs();
  const repair = createRepairResolver(index.retained.map(page => page.slug.toLowerCase()), pending);
  const report = classifyAnswerCitations(body, index);
  return report.citations.filter(citation => citation.status === "broken" && !repair(citation.target))
    .map(citation => citation.target);
}

/** The same reads over the citation index's project and the candidate record directories. */
export function genericCitationReadsOver(sources: { citations: AnswerCitationSources; candidateDirs: LegacyLocalRecordDirs }): GenericCitationReads {
  return {
    index: () => collectAnswerCitationIndexFrom(sources.citations),
    pendingSlugs: () => listLinkResolvablePendingSlugsFrom(sources.candidateDirs, { strictIo: true }),
  };
}

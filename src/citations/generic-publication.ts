/**
 * Generic default approval permits pending chains and links that the existing
 * post-write repair pass can resolve. This is separate from strict generated
 * answer policy and performs no writes or provider requests.
 */
import { collectAnswerCitationIndex } from "./answer-index.js";
import { classifyAnswerCitations } from "./answer-report.js";
import { parseFrontmatter } from "../utils/markdown.js";
import { createRepairResolver } from "../compiler/link-repair.js";
import { listLinkResolvablePendingSlugs } from "../compiler/candidate-read.js";

/** Return only broken targets that cannot resolve through production prefix repair. */
export async function genericBrokenTargets(root: string, document: string): Promise<string[]> {
  const index = await collectAnswerCitationIndex(root);
  const pending = await listLinkResolvablePendingSlugs(root, { strictIo: true });
  const repair = createRepairResolver(index.retained.map(page => page.slug.toLowerCase()), pending);
  const report = classifyAnswerCitations(parseFrontmatter(document).body, index);
  return report.citations.filter(citation => citation.status === "broken" && !repair(citation.target))
    .map(citation => citation.target);
}

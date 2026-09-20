/**
 * Persist a freshly validated query proposal as its own candidate identity.
 * The publication caller owns the lock; this writer never publishes a page or
 * refreshes live index/embedding artifacts. The proposal captures a CLOSED
 * precondition on the target page (its digest, or expect-absent) so approval
 * refuses if the page was edited or created between staging and approval.
 */
import path from "path";
import { readFile } from "fs/promises";
import { writeFreshCandidate } from "../compiler/candidates.js";
import { parseFrontmatter, slugify } from "../utils/markdown.js";
import { sha256Text } from "../connectors/hash.js";
import { QUERIES_DIR } from "../utils/constants.js";
import type { AnswerCitationReport } from "../citations/answer-types.js";
import { summarizeAnswer } from "./query-document.js";

/** A CLOSED precondition on the query page: its digest, or an explicit expect-absent. */
type QueryTargetPrecondition = { expectedTargetHash: string } | { expectTargetAbsent: true };

/**
 * Capture the target page's content digest when it exists, or expect-absent when
 * it does not (ENOENT ONLY). Any other read error refuses the proposal: a
 * precondition that cannot be captured must never fail open into a blind
 * overwrite at approval time.
 */
async function captureQueryPrecondition(root: string, slug: string): Promise<QueryTargetPrecondition> {
  try {
    return { expectedTargetHash: sha256Text(await readFile(path.join(root, QUERIES_DIR, `${slug}.md`), "utf8")) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { expectTargetAbsent: true };
    throw err;
  }
}

/** Stage exactly the document and observations checked inside the publication lock. */
export async function stageQueryProposal(input: {
  root: string; question: string; document: string; report: AnswerCitationReport;
}): Promise<string> {
  const { root, question, document, report } = input;
  const slug = slugify(question);
  const body = parseFrontmatter(document).body;
  const precondition = await captureQueryPrecondition(root, slug);
  const candidate = await writeFreshCandidate(root, {
    title: question, slug, summary: summarizeAnswer(body),
    body: document, sources: [], targetDirectory: "queries", reviewMode: "forced",
    candidateKind: { name: "validated-answer", version: 1 },
    citationManifest: { version: 1, bodyDigest: sha256Text(body), citations: report.citations },
    ...precondition,
  });
  return candidate.id;
}

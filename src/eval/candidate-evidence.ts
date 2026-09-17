/**
 * Extract pending prose against a per-run snapshot of current source text.
 * Missing and changed generation evidence stays visible and is never judged as
 * fresh. Uses the existing citation parser and source confinement boundary.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter, extractClaimCitations, splitProseParagraphs } from "../utils/markdown.js";
import { SOURCES_DIR } from "../utils/constants.js";
import { resolveSourceFile } from "./source-path.js";
import type { SourceSpan } from "../utils/types.js";
import type { CandidateAssessment, CandidateEvidence, CandidateReference } from "./candidate-types.js";

/** SHA-256 fingerprint of the UTF-8 text actually consumed. */
export function evaluationHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Read each cited source once, so hash comparison and judged lines agree. */
export function currentEvidenceReader(root: string) {
  const sources = new Map<string, Promise<string | null>>();
  return (file: string): Promise<string | null> => {
    if (!sources.has(file)) sources.set(file, readEvidence(root, file));
    return sources.get(file)!;
  };
}

/** Missing, unreadable, and rejected paths are all unavailable evidence. */
async function readEvidence(root: string, file: string): Promise<string | null> {
  const resolved = await resolveSourceFile(path.join(root, SOURCES_DIR), file);
  if (!resolved) return null;
  try { return await readFile(resolved, "utf8"); }
  catch { return null; }
}

/** Describe source identity before deciding whether its range is judgeable. */
function evidenceStatus(sourceHash: string | undefined, generationHash: string | undefined): CandidateEvidence["status"] {
  if (!sourceHash) return "unavailable";
  if (!generationHash) return "unrecorded";
  return sourceHash === generationHash ? "matches-generation" : "changed";
}

/** Validate a range before slicing: truncation would hide out-of-bounds evidence. */
function rangeIsValid(start: number, end: number, count: number): boolean {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 1 && end >= start && end <= count;
}

/** Materialize only usable excerpts from the captured source, never another read. */
function excerptReason(evidence: CandidateEvidence, text: string): string | undefined {
  if (evidence.status === "changed") return "Source changed since candidate generation; regenerate or review the new evidence.";
  const { lineStart: start, lineEnd: end } = evidence;
  if (start === undefined || end === undefined) return "Citation has no usable line range.";
  const lines = text.split("\n");
  if (!rangeIsValid(start, end, lines.length)) return "Citation line range is outside the current source.";
  evidence.spanText = lines.slice(start - 1, end).join("\n");
  return evidence.spanText.trim() ? undefined : "Cited excerpt is empty.";
}

/** Bind a parsed span to its current and generation-time source fingerprints. */
async function inspectSpan(
  hashes: Record<string, string>, span: SourceSpan, read: ReturnType<typeof currentEvidenceReader>,
): Promise<{ evidence: CandidateEvidence; reason?: string }> {
  const text = await read(span.file);
  const generationHash = Object.hasOwn(hashes, span.file) ? hashes[span.file] : undefined;
  const sourceHash = text === null ? undefined : evaluationHash(text);
  const status = evidenceStatus(sourceHash, generationHash);
  const evidence: CandidateEvidence = { file: span.file, sourceHash, generationHash, status,
    lineStart: span.lines?.start, lineEnd: span.lines?.end };
  if (text === null) return { evidence, reason: "Source is missing, unreadable, or outside sources/." };
  return { evidence, reason: excerptReason(evidence, text) };
}

/** Extract every prose observation, retaining unjudgeable cases in the report. */
export async function candidateAssessments(
  snapshot: { body: string; hashes: Record<string, string> }, reference: CandidateReference, read: ReturnType<typeof currentEvidenceReader>,
): Promise<{ assessments: CandidateAssessment[]; prose: number; cited: number }> {
  const paragraphs = splitProseParagraphs(parseFrontmatter(snapshot.body).body);
  const assessments: CandidateAssessment[] = [];
  let cited = 0;
  for (const [index, paragraph] of paragraphs.entries()) {
    const spans = extractClaimCitations(paragraph).flatMap(citation => citation.spans);
    const claimText = paragraph.replace(/\^\[[^\]]+\]/g, "").trim();
    if (spans.length) cited++;
    const base = { candidate: reference, paragraph: index + 1, claimText };
    if (!spans.length) {
      assessments.push({ ...base, id: evaluationHash(JSON.stringify([reference, index])),
        status: "unjudgeable", reason: "Prose has no usable citation." });
    }
    for (const [spanIndex, span] of spans.entries()) {
      const { evidence, reason } = await inspectSpan(snapshot.hashes, span, read);
      assessments.push({ ...base, evidence, reason,
        id: evaluationHash(JSON.stringify([reference, index, spanIndex, claimText, evidence])),
        status: reason ? "unjudgeable" : "eligible" });
    }
  }
  return { assessments, prose: paragraphs.length, cited };
}

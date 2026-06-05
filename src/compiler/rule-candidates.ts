/**
 * RuleCandidate persistence for the llmwiki rule-extraction pipeline (rule pipeline).
 *
 * Parallel to `candidates.ts` (the concept review queue) but for structured
 * `RuleCandidate` records. `llmwiki rules extract` writes one JSON file per
 * candidate under `.llmwiki/rule-candidates/<id>.json`; `rules approve`/`reject`
 * flip `status` (and archive rejects); `rules export` emits the array the rule importer
 * consumes. The full candidate is stored on disk so approval is a pure
 * status flip — the LLM is never called again at approval time.
 *
 * Candidate JSON is the canonical the rule importer import shape: camelCase keys, tagged
 * evidence, lowercase status/confidence. Do not reshape it for local use.
 */

import path from "path";
import { createHash } from "node:crypto";
import { atomicWrite, safeReadFile, slugify } from "../utils/markdown.js";
import {
  CANDIDATE_JSON_EXT,
  candidateFileId,
  listCandidateFileIds,
  moveCandidateToArchive,
} from "../utils/candidate-store.js";
import {
  RULE_CANDIDATES_DIR,
  RULE_CANDIDATES_ARCHIVE_DIR,
} from "../utils/constants.js";
import type {
  EvidenceRef,
  RuleCandidate,
  RuleConfidence,
  RuleProvenance,
  RuleStatus,
} from "../utils/rule-types.js";

/** Allowed confidence values, used by the on-disk validity guard. */
const CONFIDENCE_VALUES: readonly RuleConfidence[] = ["low", "medium", "high"];

/** Allowed status values, used by the on-disk validity guard. */
const STATUS_VALUES: readonly RuleStatus[] = ["proposed", "approved", "rejected"];

/** Absolute path to a rule candidate's JSON file. */
function ruleCandidatePath(root: string, id: string): string {
  return path.join(root, RULE_CANDIDATES_DIR, `${id}${CANDIDATE_JSON_EXT}`);
}

/** Absolute path to the archived JSON file for a rejected rule candidate. */
function ruleArchivePath(root: string, id: string): string {
  return path.join(root, RULE_CANDIDATES_ARCHIVE_DIR, `${id}${CANDIDATE_JSON_EXT}`);
}

/** the rule importer contract caps (mirrored from the rule-import contract rule_candidate_validation.rs). */
const CATEGORY_CAP = 64;
const TITLE_CAP = 256;
const PREDICATE_CAP = 512;
const EVIDENCE_REF_CAP = 1024;
const MAX_EVIDENCE_PER_CANDIDATE = 64;
const CANDIDATE_ID_RE = /^rulecand\.[a-z0-9_]+\.[a-z0-9-]+$/;
const RULE_ID_RE = /^rule\.[a-z0-9_]+\.[a-z0-9-]+$/;

/**
 * Normalize a raw LLM category into the rule importer's category alphabet `[a-z0-9_]+`.
 * the rule importer rejects hyphens in the category segment, but `slugify` emits them, so
 * a multi-word category ("code review") must collapse to underscores
 * ("code_review") or the candidate is silently dropped at import.
 * @param raw - The model-supplied category string.
 */
export function sanitizeRuleCategory(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "general").slice(0, CATEGORY_CAP);
}

/**
 * Build a collision-resistant slug segment in the rule importer's slug alphabet `[a-z0-9-]+`.
 * Appends a short hex digest of a content signature (source identity + rule
 * body) so two rules with the same title — across sources or from similar LLM
 * outputs — never collapse onto the same candidate id/file.
 * @param title - The rule title.
 * @param contentSignature - Stable per-rule signature (e.g. source + when + then).
 */
export function buildRuleSlug(title: string, contentSignature: string): string {
  const base = slugify(title);
  const hash = createHash("sha256").update(contentSignature).digest("hex").slice(0, 8);
  return base ? `${base}-${hash}` : `rule-${hash}`;
}

/**
 * Producer-side mirror of the rule importer's import gate. Returns an error string when a
 * candidate would be rejected at import (bad id/category alphabet, oversized
 * field, non-https url, unsafe evidence path, too many refs), or null when it
 * is importable. Keeps the producer from "successfully" emitting candidates
 * the rule importer silently refuses.
 * @param c - The candidate to validate.
 */
export function validateRuleCandidate(c: RuleCandidate): string | null {
  if (!CANDIDATE_ID_RE.test(c.id)) return `candidate id "${c.id}" violates ${CANDIDATE_ID_RE}`;
  if (!RULE_ID_RE.test(c.proposed.id)) return `proposed rule id "${c.proposed.id}" violates ${RULE_ID_RE}`;
  const capError = firstFieldOverCap(c);
  if (capError) return capError;
  if (c.evidence.length > MAX_EVIDENCE_PER_CANDIDATE) {
    return `too many evidence refs: ${c.evidence.length} (max ${MAX_EVIDENCE_PER_CANDIDATE})`;
  }
  return firstEvidenceError(c.evidence);
}

/** First over-cap proposed-rule field, or null. */
function firstFieldOverCap(c: RuleCandidate): string | null {
  const checks: Array<[string, string, number]> = [
    ["category", c.proposed.category, CATEGORY_CAP],
    ["title", c.proposed.title, TITLE_CAP],
    ["when", c.proposed.when, PREDICATE_CAP],
    ["then", c.proposed.then, PREDICATE_CAP],
  ];
  for (const [name, value, cap] of checks) {
    if (value.length > cap) return `${name} exceeds ${cap} chars`;
  }
  return null;
}

/** First evidence ref that the rule importer would reject (scheme/path/length), or null. */
function firstEvidenceError(evidence: EvidenceRef[]): string | null {
  for (const ref of evidence) {
    const error = evidenceRefError(ref);
    if (error) return error;
  }
  return null;
}

/** the rule importer's per-ref check for the two network/filesystem-backed evidence kinds. */
function evidenceRefError(ref: EvidenceRef): string | null {
  if (ref.kind === "url") return urlEvidenceError(ref.url);
  if (ref.kind === "file") return fileEvidenceError(ref.path);
  return null;
}

/** Url evidence must be https and within the reference cap. */
function urlEvidenceError(url: string): string | null {
  if (url.length > EVIDENCE_REF_CAP) return `evidence url exceeds ${EVIDENCE_REF_CAP} chars`;
  if (!url.startsWith("https://")) return `url evidence must be https: ${url}`;
  return null;
}

/** File evidence must be a safe relative path within the reference cap. */
function fileEvidenceError(filePath: string): string | null {
  if (filePath.length > EVIDENCE_REF_CAP) return `evidence path exceeds ${EVIDENCE_REF_CAP} chars`;
  if (isUnsafeEvidencePath(filePath)) return `unsafe evidence path: ${filePath}`;
  return null;
}

/** Reject absolute paths, Windows drive/UNC roots, and any `..` traversal segment. */
function isUnsafeEvidencePath(p: string): boolean {
  if (p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:/.test(p)) return true;
  return p.split(/[/\\]/).some((seg) => seg === "..");
}

/** Input shape for assembling a new candidate (id/status/createdAt derived here). */
export interface RuleCandidateDraft {
  category: string;
  slug: string;
  title: string;
  description: string;
  when: string;
  then: string;
  evidence: EvidenceRef[];
  provenance: RuleProvenance;
  confidence: RuleConfidence;
}

/**
 * Assemble a RuleCandidate from a draft. Ids follow the rule importer's convention
 * (`rulecand.<category>.<slug>` / `rule.<category>.<slug>`), status starts at
 * `proposed`, and version starts at 1.
 * @param draft - The extracted rule fields.
 * @param createdAt - RFC3339 creation timestamp (injected for determinism).
 */
export function buildRuleCandidate(
  draft: RuleCandidateDraft,
  createdAt: string,
): RuleCandidate {
  return {
    id: `rulecand.${draft.category}.${draft.slug}`,
    proposed: {
      id: `rule.${draft.category}.${draft.slug}`,
      category: draft.category,
      title: draft.title,
      description: draft.description,
      when: draft.when,
      then: draft.then,
      version: 1,
    },
    evidence: draft.evidence,
    provenance: draft.provenance,
    confidence: draft.confidence,
    status: "proposed",
    createdAt,
  };
}

/**
 * Persist a rule candidate as JSON. The filename is derived from the id with
 * `.` replaced by `-` so it is a safe single path segment.
 * @param root - Project root directory.
 * @param candidate - Fully-formed candidate to write.
 * @returns The path the candidate was written to.
 */
export async function writeRuleCandidate(
  root: string,
  candidate: RuleCandidate,
): Promise<string> {
  const fileId = candidateFileId(candidate.id);
  const target = ruleCandidatePath(root, fileId);
  await atomicWrite(target, JSON.stringify(candidate, null, 2));
  return target;
}

/** Defensive type-guard so corrupted candidate files don't blow up the CLI. */
function isValidRuleCandidate(value: unknown): value is RuleCandidate {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.createdAt === "string" &&
    Array.isArray(c.evidence) &&
    typeof c.proposed === "object" &&
    c.proposed !== null &&
    CONFIDENCE_VALUES.includes(c.confidence as RuleConfidence) &&
    STATUS_VALUES.includes(c.status as RuleStatus)
  );
}

/** Read one candidate JSON file. Returns null when missing or malformed. */
export async function readRuleCandidate(
  root: string,
  fileId: string,
): Promise<RuleCandidate | null> {
  const raw = await safeReadFile(ruleCandidatePath(root, fileId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isValidRuleCandidate(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * List every pending rule candidate, sorted by createdAt then id so the order
 * is deterministic. Skips non-JSON entries (e.g. the archive subdirectory).
 * @param root - Project root directory.
 */
export async function listRuleCandidates(root: string): Promise<RuleCandidate[]> {
  const dir = path.join(root, RULE_CANDIDATES_DIR);
  const fileIds = await listCandidateFileIds(dir);
  const candidates: RuleCandidate[] = [];
  for (const fileId of fileIds) {
    const candidate = await readRuleCandidate(root, fileId);
    if (candidate) candidates.push(candidate);
  }

  candidates.sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  return candidates;
}

/**
 * Flip a pending candidate's status in place and rewrite its file.
 * @param root - Project root directory.
 * @param fileId - Filesystem id of the candidate (dotted id with `.`→`-`).
 * @param status - New status to set.
 * @returns The updated candidate, or null when it did not exist.
 */
export async function setRuleCandidateStatus(
  root: string,
  fileId: string,
  status: RuleStatus,
): Promise<RuleCandidate | null> {
  const candidate = await readRuleCandidate(root, fileId);
  if (!candidate) return null;
  const updated: RuleCandidate = { ...candidate, status };
  await atomicWrite(
    ruleCandidatePath(root, fileId),
    JSON.stringify(updated, null, 2),
  );
  return updated;
}

/**
 * Archive a candidate into the archive subdirectory so rejected proposals stay
 * auditable. The status flip to "rejected" happens before this via
 * {@link setRuleCandidateStatus}; here we only move the file.
 * @returns True when the candidate existed and was moved.
 */
export async function archiveRuleCandidate(
  root: string,
  fileId: string,
): Promise<boolean> {
  return moveCandidateToArchive(
    ruleCandidatePath(root, fileId),
    ruleArchivePath(root, fileId),
  );
}

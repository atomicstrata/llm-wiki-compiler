/**
 * RuleCandidate persistence for the llmwiki rule-extraction pipeline (radar W2).
 *
 * Parallel to `candidates.ts` (the concept review queue) but for structured
 * `RuleCandidate` records. `llmwiki rules extract` writes one JSON file per
 * candidate under `.llmwiki/rule-candidates/<id>.json`; `rules approve`/`reject`
 * flip `status` (and archive rejects); `rules export` emits the array Radar
 * consumes. The full candidate is stored on disk so approval is a pure
 * status flip — the LLM is never called again at approval time.
 *
 * Candidate JSON is the canonical Radar import shape: camelCase keys, tagged
 * evidence, lowercase status/confidence. Do not reshape it for local use.
 */

import path from "path";
import { atomicWrite, safeReadFile } from "../utils/markdown.js";
import {
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

/** Filesystem extension used for rule-candidate JSON files. */
const RULE_CANDIDATE_EXT = ".json";

/** Allowed confidence values, used by the on-disk validity guard. */
const CONFIDENCE_VALUES: readonly RuleConfidence[] = ["low", "medium", "high"];

/** Allowed status values, used by the on-disk validity guard. */
const STATUS_VALUES: readonly RuleStatus[] = ["proposed", "approved", "rejected"];

/** Absolute path to a rule candidate's JSON file. */
function ruleCandidatePath(root: string, id: string): string {
  return path.join(root, RULE_CANDIDATES_DIR, `${id}${RULE_CANDIDATE_EXT}`);
}

/** Absolute path to the archived JSON file for a rejected rule candidate. */
function ruleArchivePath(root: string, id: string): string {
  return path.join(root, RULE_CANDIDATES_ARCHIVE_DIR, `${id}${RULE_CANDIDATE_EXT}`);
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
 * Assemble a RuleCandidate from a draft. Ids follow Radar's convention
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
  const fileId = fileIdFor(candidate.id);
  const target = ruleCandidatePath(root, fileId);
  await atomicWrite(target, JSON.stringify(candidate, null, 2));
  return target;
}

/** Turn a dotted candidate id into a filesystem-safe single segment. */
function fileIdFor(candidateId: string): string {
  return candidateId.replace(/[^a-zA-Z0-9_-]/g, "-");
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

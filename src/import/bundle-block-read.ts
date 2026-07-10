/**
 * @file Parse the bundle-level `x-llmwiki` block off an OKF `index.md` as
 * UNTRUSTED input and reduce it to inert import-report sections (CLP 7.6 Task 3).
 *
 * The exporter (Task 2) emits `x-llmwiki: { profile, relations, workflows }` onto
 * `index.md` frontmatter. A foreign bundle is untrusted, so this module is an
 * INDEPENDENT validator — never a cast of the exporter's types:
 *
 *  - every leaf is type-checked; a malformed entry is DROPPED with a warning
 *    rather than throwing, so one bad relation never sinks the whole import;
 *  - the whole block is refused (with a warning) when its serialized value
 *    exceeds `maxIndexBlockBytes`, and a relation/workflow LIST is refused whole
 *    (never truncated) when it exceeds its cap — a partial list would
 *    misrepresent the graph — while the profile sub-block is retained;
 *  - {@link buildBundleSections} only READS the local profile to build a mismatch
 *    summary; nothing here flows into any write of `.llmwiki/profile.json` or
 *    `.llmwiki/config.json` (Invariant 7 / D-7.6.8 — the parsed block is inert).
 */
import { loadNonDefaultProfile } from "../profile/block.js";
import type { OkfImportLimits } from "./types.js";
import type {
  BundleProfileBlock,
  BundleRelationEntry,
  BundleWorkflowEntry,
} from "../export/okf/bundle-block.js";

/** The reserved bundle-metadata frontmatter key the exporter writes on index.md. */
const BLOCK_KEY = "x-llmwiki";

/** OQ12 (D-7.6.11): a differing profile digest does NOT migrate local schema. */
const OQ12_NOTE =
  "bundle records are interpreted through the active local profile (no migration)";

/** Default-project note: no active profile, so the built-in default interprets records. */
const NO_ACTIVE_PROFILE_NOTE =
  "no active profile; bundle records interpreted through the built-in default (no migration)";

/** The untrusted, independently-validated parse of the bundle block (profile optional). */
export interface ParsedBundleBlock {
  /** Present only when the profile sub-block's identity validated. */
  profile?: BundleProfileBlock;
  relations: BundleRelationEntry[];
  workflows: BundleWorkflowEntry[];
}

/** How the bundle's declared profile differs from the ACTIVE LOCAL profile. */
export interface BundleProfileMismatch {
  /** True when the local project runs the built-in default (no active profile). */
  noActiveProfile?: boolean;
  differingProfileId?: { bundle: string; local: string };
  differingProfileContentHash?: { bundle: string; local: string };
  /** Bundle entity/relation types not declared under the active local profile. */
  entityTypesNotDeclaredLocally: string[];
  relationTypesNotDeclaredLocally: string[];
  /** Present when records are interpreted through a different (or the default) profile. */
  note?: string;
}

/** The parsed foreign profile identity plus its mismatch vs the local profile. */
export interface BundleProfileReport {
  profile: BundleProfileBlock;
  mismatch: BundleProfileMismatch;
}

/** Parsed relations: a count plus the entries carried through for later application (Task 5). */
export interface BundleRelationsReport {
  count: number;
  entries: BundleRelationEntry[];
}

/** Parsed workflow-run summaries — surfaced only; INERT (D-7.6.7). */
export interface BundleWorkflowsReport {
  count: number;
  runIds: string[];
}

/** The additive import-report sections a parsed bundle block contributes. */
export interface BundleReportSections {
  bundleProfile?: BundleProfileReport;
  bundleRelations?: BundleRelationsReport;
  bundleWorkflows?: BundleWorkflowsReport;
}

type Warn = (msg: string) => void;

/** True for a plain object (not an array, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Byte size of a value's JSON serialization, or `undefined` when it cannot be serialized. */
function serializedByteSize(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "");
  } catch {
    return undefined;
  }
}

/** Keep only the string elements of an array field, warning if any were dropped or it was not an array. */
function stringList(value: unknown, field: string, warn: Warn): string[] {
  if (!Array.isArray(value)) {
    if (value !== undefined) warn(`OKF import: bundle profile ${field} is not a list; ignored`);
    return [];
  }
  const strings = value.filter((item): item is string => typeof item === "string");
  if (strings.length !== value.length) warn(`OKF import: dropped non-string ${field} entries in bundle profile`);
  return strings;
}

/** Parse the producer sub-object leniently (informational; never gates the profile). */
function parseProducer(value: unknown): { name: string; version: string } {
  const raw = isRecord(value) ? value : {};
  const name = typeof raw.name === "string" ? raw.name : "unknown";
  const version = typeof raw.version === "string" ? raw.version : "unknown";
  return { name, version };
}

/** Validate the profile sub-block; DROP it whole (warn) when its required identity is malformed. */
function parseProfile(value: unknown, warn: Warn): BundleProfileBlock | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) { warn("OKF import: bundle profile block is malformed; ignored"); return undefined; }
  const { profileId, profileContentHash, profileSchemaVersion, profileVersion } = value;
  if (typeof profileId !== "string" || typeof profileContentHash !== "string" || typeof profileSchemaVersion !== "number") {
    warn("OKF import: bundle profile identity is malformed; profile metadata ignored");
    return undefined;
  }
  return {
    profileId,
    ...(typeof profileVersion === "string" ? { profileVersion } : {}),
    profileSchemaVersion,
    profileContentHash,
    entityTypes: stringList(value.entityTypes, "entityTypes", warn),
    relationTypes: stringList(value.relationTypes, "relationTypes", warn),
    artifactTypes: stringList(value.artifactTypes, "artifactTypes", warn),
    producer: parseProducer(value.producer),
  };
}

/** Validate one relation entry; return `null` (caller drops + warns) when any required leaf is malformed. */
function parseRelation(value: unknown): BundleRelationEntry | null {
  if (!isRecord(value)) return null;
  const { id, type, from, to, contentHash, attributes } = value;
  if ([id, type, from, to, contentHash].some((leaf) => typeof leaf !== "string")) return null;
  return {
    id: id as string, type: type as string, from: from as string, to: to as string,
    ...(isRecord(attributes) ? { attributes } : {}),
    contentHash: contentHash as string,
  };
}

/** Validate one workflow-run summary; return `null` when any required leaf is malformed. */
function parseWorkflow(value: unknown): BundleWorkflowEntry | null {
  if (!isRecord(value)) return null;
  const { runId, workflowId, status, currentStage, workflowDigest, profileDigest } = value;
  if ([runId, workflowId, status, workflowDigest, profileDigest].some((leaf) => typeof leaf !== "string")) return null;
  if (currentStage !== null && typeof currentStage !== "string") return null;
  return {
    runId: runId as string, workflowId: workflowId as string, status: status as string,
    currentStage: currentStage as string | null,
    satisfiedGates: stringList(value.satisfiedGates, "satisfiedGates", () => {}),
    stages: parseStages(value.stages),
    workflowDigest: workflowDigest as string, profileDigest: profileDigest as string,
  };
}

/** Keep only well-formed `{ id, status }` stage entries. */
function parseStages(value: unknown): Array<{ id: string; status: string }> {
  if (!Array.isArray(value)) return [];
  const stages: Array<{ id: string; status: string }> = [];
  for (const entry of value) {
    if (isRecord(entry) && typeof entry.id === "string" && typeof entry.status === "string") {
      stages.push({ id: entry.id, status: entry.status });
    }
  }
  return stages;
}

/**
 * Parse a capped list field: refuse the WHOLE list (return `[]` + warn) when it
 * exceeds `cap`, else validate each element and drop the malformed ones (warn once).
 */
function parseList<T>(
  value: unknown, cap: number, kind: string, parseOne: (v: unknown) => T | null, warn: Warn,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { warn(`OKF import: bundle ${kind} is not a list; ignored`); return []; }
  if (value.length > cap) { warn(`OKF import: bundle ${kind} list exceeds cap (${cap}); list refused`); return []; }
  const kept = value.map(parseOne).filter((item): item is T => item !== null);
  if (kept.length !== value.length) warn(`OKF import: dropped ${value.length - kept.length} malformed bundle ${kind} entr(y/ies)`);
  return kept;
}

/**
 * Parse the untrusted `index.md` `x-llmwiki` block into an inert
 * {@link ParsedBundleBlock}, collecting a warning per dropped/refused item.
 *
 * @param indexFrontmatter - The parsed `index.md` frontmatter (may be `{}`).
 * @param limits - Resource caps (byte cap + per-list caps, D-7.6.9).
 * @returns The parsed block (absent when the key is missing or byte-refused) and warnings.
 */
export function parseBundleBlock(
  indexFrontmatter: Record<string, unknown>,
  limits: OkfImportLimits,
): { block?: ParsedBundleBlock; warnings: string[] } {
  const warnings: string[] = [];
  const warn: Warn = (msg) => warnings.push(msg);
  const raw = indexFrontmatter[BLOCK_KEY];
  if (raw === undefined) return { warnings };
  const size = serializedByteSize(raw);
  if (size === undefined || size > limits.maxIndexBlockBytes) {
    warn(`OKF import: bundle metadata block exceeds byte cap (${limits.maxIndexBlockBytes}); block refused`);
    return { warnings };
  }
  if (!isRecord(raw)) { warn("OKF import: bundle metadata block is not a mapping; ignored"); return { warnings }; }
  const block: ParsedBundleBlock = {
    profile: parseProfile(raw.profile, warn),
    relations: parseList(raw.relations, limits.maxRelations, "relation", parseRelation, warn),
    workflows: parseList(raw.workflows, limits.maxWorkflowRuns, "workflow", parseWorkflow, warn),
  };
  return { block, warnings };
}

/** Elements of `candidates` not present in the local `declared` set. */
function notDeclaredLocally(candidates: string[], declared: string[]): string[] {
  const local = new Set(declared);
  return candidates.filter((name) => !local.has(name));
}

/**
 * Compare the bundle's declared profile against the ACTIVE LOCAL profile (READ-only:
 * loads the local profile, writes nothing). A default-profile project yields a
 * `noActiveProfile` note; a differing digest attaches the OQ12 no-migration note.
 */
async function buildMismatch(root: string, profile: BundleProfileBlock): Promise<BundleProfileMismatch> {
  const local = await loadNonDefaultProfile(root);
  if (local === undefined) {
    return {
      noActiveProfile: true,
      entityTypesNotDeclaredLocally: profile.entityTypes,
      relationTypesNotDeclaredLocally: profile.relationTypes,
      note: NO_ACTIVE_PROFILE_NOTE,
    };
  }
  const mismatch: BundleProfileMismatch = {
    entityTypesNotDeclaredLocally: notDeclaredLocally(profile.entityTypes, Object.keys(local.profile.entities)),
    relationTypesNotDeclaredLocally: notDeclaredLocally(profile.relationTypes, Object.keys(local.profile.relations ?? {})),
  };
  if (profile.profileId !== local.profile.profileId) mismatch.differingProfileId = { bundle: profile.profileId, local: local.profile.profileId };
  if (profile.profileContentHash !== local.digest) {
    mismatch.differingProfileContentHash = { bundle: profile.profileContentHash, local: local.digest };
    mismatch.note = OQ12_NOTE;
  }
  return mismatch;
}

/**
 * Reduce a parsed bundle block to the inert import-report sections: the foreign
 * profile identity + its mismatch vs the active local profile, the relation count
 * + carried entries (reachable by relation application, Task 5), and the workflow
 * count + run ids (surfaced only). Reads the local profile; performs NO writes.
 *
 * @param root - Absolute project root directory.
 * @param block - The parsed (untrusted) bundle block.
 * @returns The additive report sections for {@link runOkfImport}'s report.
 */
export async function buildBundleSections(
  root: string,
  block: ParsedBundleBlock,
): Promise<BundleReportSections> {
  const sections: BundleReportSections = {
    bundleRelations: { count: block.relations.length, entries: block.relations },
    bundleWorkflows: { count: block.workflows.length, runIds: block.workflows.map((run) => run.runId) },
  };
  if (block.profile !== undefined) {
    sections.bundleProfile = { profile: block.profile, mismatch: await buildMismatch(root, block.profile) };
  }
  return sections;
}

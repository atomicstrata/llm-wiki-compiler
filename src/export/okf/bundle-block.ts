/**
 * @file Build the bundle-level `x-llmwiki` metadata block for a NON-DEFAULT
 * profile project's OKF `index.md` frontmatter.
 *
 * Profile-aware extension of the OKF export (CLP 7.6, D-7.6.1/2/7/10): a bundle
 * produced from a non-default profile carries a single reserved block on
 * `index.md` frontmatter — `x-llmwiki: { profile, relations, workflows }` —
 * describing the profile identity + producer, the live relation graph, and a
 * BOUNDED per-run workflow summary. One reserved file to parse, one place to cap.
 *
 * - `profile` (D-7.6.2): the profile id/version/schema-version, its content
 *   digest, the sorted schema-id lists the bundle uses (entity/relation/artifact
 *   types), and the producer (`llmwiki` + package version).
 * - `relations`: one entry per LIVE, profile-valid relation, sorted by id.
 *   `evidence` is intentionally omitted in v0 (citation refs are project-local).
 * - `workflows` (D-7.6.7): one BOUNDED summary per readable run, sorted by runId
 *   — never the events, inputs/outputs bodies, or the local-integrity HMAC.
 *
 * DEFAULT PARITY (D-7.6.10, hard invariant): {@link collectBundleBlock} returns
 * `undefined` for a default-profile project (its caller then omits the block
 * entirely), so a default bundle's `index.md` stays byte-identical to a pre-7.6
 * export. Output is deterministic: every list is sorted and no timestamps ride.
 */
import { readLiveValidRelations } from "../../relations/live-valid.js";
import { listRuns, readRun } from "../../workflows/store.js";
import type { LoadedProfile } from "../../profile/types.js";
import type { RelationRef } from "../../relations/types.js";
import type { WorkflowRun } from "../../workflows/types.js";
import pkg from "../../../package.json";

/** Producer identity stamped into every profile block. */
const PRODUCER_NAME = "llmwiki";

/** This build's producer version (the published package version). */
const PRODUCER_VERSION: string = pkg.version;

/** The bundle profile identity + producer sub-block (D-7.6.2). */
export interface BundleProfileBlock {
  profileId: string;
  /** Omitted when the profile declares no version. */
  profileVersion?: string;
  profileSchemaVersion: number;
  profileContentHash: string;
  entityTypes: string[];
  relationTypes: string[];
  artifactTypes: string[];
  producer: { name: string; version: string };
}

/** One live relation, flattened for the bundle graph (evidence omitted in v0). */
export interface BundleRelationEntry {
  id: string;
  type: string;
  from: string;
  to: string;
  /** Omitted when the relation carries no attributes. */
  attributes?: Record<string, unknown>;
  contentHash: string;
}

/** A BOUNDED per-run workflow summary (D-7.6.7) — no events/inputs/outputs/integrity. */
export interface BundleWorkflowEntry {
  runId: string;
  workflowId: string;
  status: string;
  currentStage: string | null;
  satisfiedGates: string[];
  stages: Array<{ id: string; status: string }>;
  workflowDigest: string;
  profileDigest: string;
}

/** The full `x-llmwiki` bundle block emitted onto `index.md` frontmatter. */
export interface BundleBlock {
  profile: BundleProfileBlock;
  relations: BundleRelationEntry[];
  workflows: BundleWorkflowEntry[];
}

/** Sorted keys of an optional record, or `[]` when the block is absent. */
function sortedKeys(block: Record<string, unknown> | undefined): string[] {
  return block ? Object.keys(block).sort() : [];
}

/** Build the profile identity/producer sub-block from a loaded non-default profile. */
function buildProfileSubBlock(loaded: LoadedProfile): BundleProfileBlock {
  const { profile } = loaded;
  return {
    profileId: profile.profileId,
    ...(profile.profileVersion !== undefined ? { profileVersion: profile.profileVersion } : {}),
    profileSchemaVersion: profile.schemaVersion,
    profileContentHash: loaded.digest,
    entityTypes: sortedKeys(profile.entities),
    relationTypes: sortedKeys(profile.relations),
    artifactTypes: sortedKeys(profile.artifacts),
    producer: { name: PRODUCER_NAME, version: PRODUCER_VERSION },
  };
}

/** Flatten one relation to its bundle entry (attributes omitted when empty). */
function toRelationEntry(rel: RelationRef): BundleRelationEntry {
  const hasAttributes = Object.keys(rel.attributes).length > 0;
  return {
    id: rel.id,
    type: rel.type,
    from: rel.from,
    to: rel.to,
    ...(hasAttributes ? { attributes: rel.attributes } : {}),
    contentHash: rel.contentHash,
  };
}

/** Total order over bundle entries by their `id`/`runId` string key (deterministic output). */
function byStringKey<T>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const [ka, kb] = [key(a), key(b)];
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
}

/** Collect the live, profile-valid relations as sorted bundle entries. */
async function collectRelationEntries(loaded: LoadedProfile, root: string): Promise<BundleRelationEntry[]> {
  const relations = await readLiveValidRelations(root, loaded.profile);
  return relations.map(toRelationEntry).sort(byStringKey((r) => r.id));
}

/** Reduce a durable run record to its BOUNDED bundle summary (D-7.6.7). */
function toWorkflowEntry(run: WorkflowRun): BundleWorkflowEntry {
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    status: run.status,
    currentStage: run.currentStage,
    satisfiedGates: run.satisfiedGates,
    stages: run.stageLog.map((entry) => ({ id: entry.stageId, status: entry.status })),
    workflowDigest: run.workflowDigest,
    profileDigest: run.profileDigest,
  };
}

/**
 * Collect a bounded summary of every READABLE workflow run, sorted by runId. An
 * unavailable store or an individual unreadable run contributes nothing (the
 * summary is best-effort metadata, never a trust surface); foreign run records
 * are never materialized (D-7.6.7 keeps them export-only + inert on import).
 */
async function collectWorkflowEntries(root: string): Promise<BundleWorkflowEntry[]> {
  const list = await listRuns(root);
  if (list.status !== "ok") return [];
  const entries: BundleWorkflowEntry[] = [];
  for (const runId of list.runIds) {
    const read = await readRun(root, runId);
    if (read.status === "ok") entries.push(toWorkflowEntry(read.run));
  }
  return entries.sort(byStringKey((entry) => entry.runId));
}

/**
 * Build the bundle-level `x-llmwiki` block for the ACTIVE profile, or `undefined`
 * for a default-profile project (byte-identical parity, D-7.6.10 — the caller
 * omits the block). The `loaded` profile is threaded in from the caller so the
 * export loads (and validates) it ONCE across every profile-aware surface.
 *
 * @param root - Absolute project root directory.
 * @param loaded - The active non-default profile, or `undefined` for the default.
 * @returns The assembled bundle block, or `undefined` for a default project.
 */
export async function collectBundleBlock(
  root: string,
  loaded: LoadedProfile | undefined,
): Promise<BundleBlock | undefined> {
  if (loaded === undefined) return undefined;
  return {
    profile: buildProfileSubBlock(loaded),
    relations: await collectRelationEntries(loaded, root),
    workflows: await collectWorkflowEntries(root),
  };
}

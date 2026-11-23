/**
 * @file src/profile/templates/corpus.ts
 * @description Conservative typed-corpus probe for safe profile template installation.
 *
 * ONE PROBE BODY: {@link isTypedCorpusEmptyFrom} owns the order (entity
 * directories, relations, artifacts, workflow runs, candidates and archive,
 * events) and every reason string over {@link TypedCorpusReads}: the relation,
 * event and workflow stores' own bound reads, and two physical looks — one
 * confined directory listing and the bounded first-file scan, both unchanged
 * below. The root form keeps its signature and builds the local reads per call.
 */
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { diskEventReadSources, readEventsFrom, type EventReadSources } from "../../events/store-read.js";
import { readRelationsFrom } from "../../relations/store-read.js";
import { CANDIDATES_ARCHIVE_DIR, CANDIDATES_DIR } from "../../utils/constants.js";
import { type GraphStoreReads } from "../../utils/jsonl-store.js";
import { diskRelationGraphReads } from "../../relations/graph-reads.js";
import { confineUnderRoot } from "../../utils/path-confine.js";
import { diskWorkflowRunReads, listRunsFrom, type WorkflowRunReads } from "../../workflow-history/store.js";
import type { LoadedProfile, ProfilePack } from "../types.js";

/** Result of checking whether a profile install can reinterpret no existing typed data. */
export interface TypedCorpusProbe {
  empty: boolean;
  reasons: string[];
}

/** What the corpus probe reads. No member takes a project root. */
export interface TypedCorpusReads {
  /** One project-relative directory's entry names, no type filter. Local: {@link confinedEntries}. */
  entries(relativeDir: string): Promise<string[] | "absent" | "unavailable">;
  /** Whether any file sits below a project-relative store. Local: {@link firstFileUnder}. */
  firstFileUnder(relativeDir: string): Promise<"absent" | "present" | "unavailable">;
  /** The relation store's graph read. Local: `diskRelationGraphReads(root)`. */
  relations: GraphStoreReads;
  /** The event store's read sources. Local: `diskEventReadSources(root)`. */
  events: EventReadSources;
  /** The workflow run store's reads. Local: `diskWorkflowRunReads(root)`. */
  workflowRuns: WorkflowRunReads;
}

/** LOCAL DISK. The probe's reads for one root, built per call; each called when asked. */
export function diskTypedCorpusReads(root: string): TypedCorpusReads {
  return {
    entries: (relativeDir) => confinedEntries(root, relativeDir),
    firstFileUnder: (relativeDir) => firstFileUnder(root, relativeDir),
    relations: diskRelationGraphReads(root),
    events: diskEventReadSources(root),
    workflowRuns: diskWorkflowRunReads(root),
  };
}

/** Return whether a profile can be installed without orphaning typed content. */
export async function isTypedCorpusEmpty(root: string, loaded: LoadedProfile, target: ProfilePack): Promise<TypedCorpusProbe> {
  return isTypedCorpusEmptyFrom(diskTypedCorpusReads(root), loaded, target);
}

/** {@link isTypedCorpusEmpty} over {@link TypedCorpusReads}: THE ONE BODY, in the incumbent order. */
export async function isTypedCorpusEmptyFrom(reads: TypedCorpusReads, loaded: LoadedProfile, target: ProfilePack): Promise<TypedCorpusProbe> {
  const reasons: string[] = [];
  await collectEntityPageReasons(reads, [loaded.profile, target], reasons);
  await collectRelationReasons(reads, reasons);
  await collectArtifactReasons(reads, reasons);
  await collectWorkflowReasons(reads, reasons);
  await collectCandidateReasons(reads, reasons);
  await collectEventReasons(reads, reasons);
  return { empty: reasons.length === 0, reasons };
}

async function collectEntityPageReasons(reads: TypedCorpusReads, profiles: ProfilePack[], reasons: string[]): Promise<void> {
  const directories = new Set(profiles.flatMap((profile) => Object.values(profile.entities).map((def) => def.directory)));
  for (const directory of directories) {
    const entries = await reads.entries(directory);
    if (entries === "unavailable") reasons.push(`typed entity directory is unreadable or unsafe: ${directory}`);
    if (Array.isArray(entries) && entries.some((entry) => entry.endsWith(".md"))) {
      reasons.push(`typed entity pages exist under ${directory}`);
    }
  }
}

async function collectRelationReasons(reads: TypedCorpusReads, reasons: string[]): Promise<void> {
  try {
    const read = await readRelationsFrom(reads.relations);
    if (read.relations.length > 0) reasons.push("relation store contains records");
    if (read.problems.length > 0) reasons.push("relation store has unresolved problems");
  } catch {
    reasons.push("relation store is unreadable or unsafe");
  }
}

async function collectEventReasons(reads: TypedCorpusReads, reasons: string[]): Promise<void> {
  try {
    const read = await readEventsFrom(reads.events);
    if (read.events.length > 0) reasons.push("event store contains records");
    if (read.problems.length > 0) reasons.push("event store has unresolved problems");
  } catch {
    reasons.push("event store is unreadable or unsafe");
  }
}

async function collectCandidateReasons(reads: TypedCorpusReads, reasons: string[]): Promise<void> {
  const entries = await reads.entries(CANDIDATES_DIR);
  if (entries === "unavailable") reasons.push("candidate store is unreadable or unsafe");
  if (Array.isArray(entries) && entries.some((entry) => entry.endsWith(".json"))) {
    reasons.push("pending review candidates exist");
  }
  const archived = await reads.entries(CANDIDATES_ARCHIVE_DIR);
  if (archived === "unavailable") reasons.push("candidate archive is unreadable or unsafe");
  if (Array.isArray(archived) && archived.some((entry) => entry.endsWith(".json"))) {
    reasons.push("archived review candidates exist");
  }
}

async function collectWorkflowReasons(reads: TypedCorpusReads, reasons: string[]): Promise<void> {
  const runs = await listRunsFrom(reads.workflowRuns);
  if (runs.status === "unavailable") {
    reasons.push(`workflow run store is unreadable or unsafe: ${runs.detail}`);
    return;
  }
  if (runs.runIds.length > 0) reasons.push("workflow runs exist");
}

async function collectArtifactReasons(reads: TypedCorpusReads, reasons: string[]): Promise<void> {
  const result = await reads.firstFileUnder("artifacts");
  if (result === "unavailable") reasons.push("artifact store is unreadable or unsafe");
  if (result === "present") reasons.push("artifact store contains files");
}

/** List a profile-owned directory without following an escaping directory path. */
export async function confinedEntries(root: string, relativeDir: string): Promise<string[] | "absent" | "unavailable"> {
  try {
    return await safeEntries(await confineUnderRoot(relativeDir, root, { mustExist: false }));
  } catch {
    return "unavailable";
  }
}

async function safeEntries(dir: string): Promise<string[] | "absent" | "unavailable"> {
  try {
    const st = await lstat(dir);
    if (!st.isDirectory()) return "unavailable";
    return await readdir(dir);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unavailable";
  }
}

/** Detect any file below a confined profile-owned store with bounded recursion. */
export async function firstFileUnder(root: string, relativeDir: string): Promise<"absent" | "present" | "unavailable"> {
  let confined: string;
  try {
    confined = await confineUnderRoot(relativeDir, root, { mustExist: false });
  } catch {
    return "unavailable";
  }
  return scanForFile(confined, 0);
}

async function scanForFile(dir: string, depth: number): Promise<"absent" | "present" | "unavailable"> {
  if (depth > 8) return "unavailable";
  const entries = await safeEntries(dir);
  if (entries === "absent" || entries === "unavailable") return entries;
  for (const entry of entries) {
    const result = await scanEntry(path.join(dir, entry), depth + 1);
    if (result !== "absent") return result;
  }
  return "absent";
}

async function scanEntry(entryPath: string, depth: number): Promise<"absent" | "present" | "unavailable"> {
  try {
    const st = await lstat(entryPath);
    if (st.isFile()) return "present";
    if (st.isDirectory()) return scanForFile(entryPath, depth);
    return "unavailable";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unavailable";
  }
}

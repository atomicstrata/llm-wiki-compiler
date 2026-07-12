/**
 * @file src/profile/templates/history-audit.ts
 * @description Strict record-level audits for candidate and workflow history
 * before a profile update can reinterpret project state.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { resolveConfinedCandidatesDir } from "../../compiler/candidate-store-paths.js";
import { readConfinedLeaf } from "../../utils/confined-read.js";
import { CANDIDATES_ARCHIVE_DIR } from "../../utils/constants.js";
import { isTerminalStatus } from "../../workflows/with-lock.js";
import { readRun } from "../../workflows/store.js";
import { confinedEntries } from "./corpus.js";

const MAX_ARCHIVED_CANDIDATE_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 10_000;

/** Validate every archived candidate record through confined capped reads. */
export async function auditCandidateArchive(root: string): Promise<string[]> {
  let dir: string | null;
  try {
    dir = await resolveConfinedCandidatesDir(root, CANDIDATES_ARCHIVE_DIR);
  } catch {
    return ["candidate archive is unreadable or unsafe"];
  }
  if (dir === null) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return ["candidate archive is unreadable or unsafe"];
  }
  if (entries.length > MAX_HISTORY_ENTRIES) return ["candidate archive exceeds its entry cap"];
  const reasons: string[] = [];
  for (const entry of entries) reasons.push(...await auditCandidateLeaf(root, entry.name, entry.isFile()));
  return reasons;
}

async function auditCandidateLeaf(root: string, name: string, isFile: boolean): Promise<string[]> {
  if (!isFile || !name.endsWith(".json")) return [`candidate archive contains unexpected entry: ${name}`];
  const expectedDir = path.join(root, CANDIDATES_ARCHIVE_DIR);
  const read = await readConfinedLeaf(root, path.join(expectedDir, name), expectedDir, MAX_ARCHIVED_CANDIDATE_BYTES);
  if (read.kind !== "ok") return [`archived candidate is unreadable or unsafe: ${name}`];
  try {
    const value = JSON.parse(read.body) as Record<string, unknown>;
    const id = name.slice(0, -".json".length);
    return validCandidate(value, id) ? [] : [`archived candidate is malformed: ${name}`];
  } catch {
    return [`archived candidate is malformed: ${name}`];
  }
}

function validCandidate(value: Record<string, unknown>, expectedId: string): boolean {
  return value.id === expectedId
    && typeof value.title === "string"
    && typeof value.slug === "string"
    && typeof value.body === "string"
    && Array.isArray(value.sources);
}

/** Validate every workflow-store entry and block every non-terminal run. */
export async function auditWorkflowHistory(root: string): Promise<Array<{ kind: "store" | "workflow"; message: string }>> {
  const entries = await confinedEntries(root, ".llmwiki/workflows/runs");
  if (entries === "absent") return [];
  if (entries === "unavailable" || entries.length > MAX_HISTORY_ENTRIES) {
    return [{ kind: "store", message: "workflow store is unreadable, unsafe, or over its entry cap" }];
  }
  const reasons: Array<{ kind: "store" | "workflow"; message: string }> = [];
  for (const name of entries) reasons.push(...await auditWorkflowLeaf(root, name));
  return reasons;
}

async function auditWorkflowLeaf(root: string, name: string): Promise<Array<{ kind: "store" | "workflow"; message: string }>> {
  if (!name.endsWith(".json")) return [{ kind: "store", message: `workflow store contains unexpected entry: ${name}` }];
  const runId = name.slice(0, -".json".length);
  const read = await readRun(root, runId);
  if (read.status !== "ok") return [{ kind: "store", message: `workflow run ${runId} is unavailable` }];
  return isTerminalStatus(read.run.status) ? [] : [{ kind: "workflow", message: `workflow run ${runId} is active` }];
}

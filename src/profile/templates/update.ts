/**
 * @file src/profile/templates/update.ts
 * @description Read-only compatibility planning for template profile updates.
 * It never writes and treats every unverifiable profile-owned store as unsafe.
 */
import canonicalize from "canonicalize";
import { CANDIDATES_ARCHIVE_DIR, CANDIDATES_DIR } from "../../utils/constants.js";
import { listRuns, readRun } from "../../workflows/store.js";
import { isTerminalStatus } from "../../workflows/with-lock.js";
import { diffProfiles, type PageDisposition, type ProfileDiffReport } from "../diff.js";
import { profileDigest } from "../digest.js";
import { loadProfile } from "../load.js";
import { lintProfileEntities } from "../lint.js";
import type { ProfilePack } from "../types.js";
import type { ProfileTemplatePackage } from "./types.js";
import { confinedEntries, firstFileUnder } from "./corpus.js";
import { readTemplateLock } from "./lock.js";
import { getBuiltinTemplate } from "./registry.js";

/** One structured refusal reason from the corpus-wide compatibility audit. */
export interface TemplateUpdateReason {
  kind: "drift" | "page" | "lint" | "candidate" | "workflow" | "artifact" | "store";
  message: string;
  path?: string;
}

/** Complete dry-run result; `compatible` implies no reasons and no writes. */
export interface TemplateUpdatePlan {
  schemaVersion: 1;
  compatible: boolean;
  from: string;
  to: string;
  oldProfileDigest: string;
  newProfileDigest: string;
  diff: ProfileDiffReport;
  reasons: TemplateUpdateReason[];
}

/** Plan a builtin update using an independently resolved installed release. */
export async function planBuiltinTemplateUpdate(root: string, requestedId?: string): Promise<TemplateUpdatePlan> {
  const lockRead = await readTemplateLock(root);
  if (lockRead.kind !== "ok") throw new Error(`cannot plan update: template provenance is ${lockRead.kind}`);
  const lock = lockRead.lock;
  if (lock.sourceType !== "builtin") throw new Error("R1 update dry-run supports builtin installs only");
  const base = getBuiltinTemplate(lock.templateId);
  if (!base || base.version !== lock.version || base.publisher !== lock.publisher) {
    throw new Error(`cannot independently resolve installed builtin ${lock.templateId}@${lock.version}`);
  }
  const candidateId = requestedId ?? lock.templateId;
  if (candidateId !== lock.templateId) throw new Error("template update cannot change template identity");
  const candidate = getBuiltinTemplate(candidateId);
  if (!candidate) throw new Error(`unknown builtin template: ${candidateId}`);
  return planTemplateUpdate(root, (await loadProfile(root)).profile, base, candidate);
}

/** Plan an update from independently verified base and candidate packages. */
export async function planTemplateUpdate(
  root: string,
  active: ProfilePack,
  base: ProfileTemplatePackage,
  candidate: ProfileTemplatePackage,
): Promise<TemplateUpdatePlan> {
  const reasons: TemplateUpdateReason[] = [];
  const activeDigest = profileDigest(active);
  const baseDigest = profileDigest(base.profile);
  if (activeDigest !== baseDigest) reasons.push({ kind: "drift", message: "active profile has local modifications" });
  const diff = await diffProfiles(root, active, candidate.profile);
  reasons.push(...diffReasons(diff));
  reasons.push(...await lintReasons(root, candidate.profile));
  reasons.push(...await candidateReasons(root));
  reasons.push(...await workflowReasons(root));
  reasons.push(...await artifactReasons(root, active, candidate.profile));
  return {
    schemaVersion: 1,
    compatible: reasons.length === 0,
    from: `${base.templateId}@${base.version}`,
    to: `${candidate.templateId}@${candidate.version}`,
    oldProfileDigest: activeDigest,
    newProfileDigest: profileDigest(candidate.profile),
    diff,
    reasons,
  };
}

function diffReasons(diff: ProfileDiffReport): TemplateUpdateReason[] {
  const reasons: TemplateUpdateReason[] = diff.problems.map((problem) => ({ kind: "store", message: problem.message, path: problem.directory }));
  for (const page of diff.pages) {
    if (isSafeDisposition(page)) continue;
    reasons.push({ kind: "page", message: `page is ${page.disposition}`, path: `${page.directory}/${page.stem}.md` });
  }
  return reasons;
}

function isSafeDisposition(page: PageDisposition): boolean {
  return page.disposition === "unchanged" || page.disposition === "newly-supported";
}

async function lintReasons(root: string, profile: ProfilePack): Promise<TemplateUpdateReason[]> {
  try {
    const findings = await lintProfileEntities(root, profile);
    return findings
      .filter((finding) => !isContentOnlyFinding(finding.rule))
      .map((finding) => ({ kind: "lint", message: `${finding.rule}: ${finding.message}`, path: finding.file }));
  } catch (error) {
    return [{ kind: "store", message: `candidate-profile validation is unavailable: ${errorMessage(error)}` }];
  }
}

function isContentOnlyFinding(rule: string): boolean {
  return rule === "empty-page" || rule === "malformed-claim-citation";
}

async function candidateReasons(root: string): Promise<TemplateUpdateReason[]> {
  const pending = await confinedEntries(root, CANDIDATES_DIR);
  if (pending === "unavailable") return [{ kind: "store", message: "candidate store is unreadable or unsafe" }];
  const archived = await confinedEntries(root, CANDIDATES_ARCHIVE_DIR);
  if (archived === "unavailable") return [{ kind: "store", message: "candidate archive is unreadable or unsafe" }];
  if (Array.isArray(pending) && pending.some(isJsonFile)) {
    return [{ kind: "candidate", message: "pending review candidates must be resolved before update" }];
  }
  return [];
}

async function workflowReasons(root: string): Promise<TemplateUpdateReason[]> {
  const listed = await listRuns(root);
  if (listed.status === "unavailable") return [{ kind: "store", message: `workflow store is unavailable: ${listed.detail}` }];
  const reasons: TemplateUpdateReason[] = [];
  for (const runId of listed.runIds) {
    const read = await readRun(root, runId);
    if (read.status !== "ok") reasons.push({ kind: "store", message: `workflow run ${runId} is unavailable` });
    else if (!isTerminalStatus(read.run.status)) reasons.push({ kind: "workflow", message: `workflow run ${runId} is active` });
  }
  return reasons;
}

async function artifactReasons(root: string, active: ProfilePack, candidate: ProfilePack): Promise<TemplateUpdateReason[]> {
  if (canonicalize(active.artifacts ?? {}) === canonicalize(candidate.artifacts ?? {})) return [];
  const state = await firstFileUnder(root, "artifacts");
  if (state === "unavailable") return [{ kind: "store", message: "artifact store is unreadable or unsafe" }];
  if (state === "present") return [{ kind: "artifact", message: "artifact contracts changed while stored artifacts exist" }];
  return [];
}

function isJsonFile(name: string): boolean {
  return name.endsWith(".json");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @file src/profile/templates/lock.ts
 * @description Strict, confined reader for advisory template provenance locks.
 * Locks help status/update locate releases but never authorize runtime behavior.
 */
import path from "node:path";
import { readCappedNoFollow } from "../../utils/confined-read.js";
import { resolveExistingConfinedPrivateDir } from "../../utils/private-dir.js";
import type {
  RemoteTemplateProvenance,
  TemplateLock,
  TemplateLockV1,
  TemplateLockV2,
  TemplateSourceType,
} from "./types.js";

export const TEMPLATE_LOCK_FILE = ".llmwiki/template-lock.json";
export const MAX_TEMPLATE_LOCK_BYTES = 64 * 1024;

/** Structured read result; faults never masquerade as a missing lock. */
export type TemplateLockRead =
  | { kind: "ok"; lock: TemplateLock }
  | { kind: "absent" }
  | { kind: "malformed"; detail: string }
  | { kind: "unavailable"; detail: string };

const COMMON_KEYS = [
  "schemaVersion", "templateId", "version", "publisher", "sourceType",
  "installedAt", "profileDigest",
] as const;
const REMOTE_KEYS = ["coordinate", "packageDigest", "tap", "indexSequence", "publisherKeyId", "verifiedAt"] as const;

/** Read an advisory lock through a resolved, confined `.llmwiki` directory. */
export async function readTemplateLock(root: string): Promise<TemplateLockRead> {
  let privateDir: string | null;
  try {
    privateDir = await resolveExistingConfinedPrivateDir(root);
  } catch {
    return { kind: "unavailable", detail: "private directory is unsafe" };
  }
  if (privateDir === null) return { kind: "absent" };
  const read = await readCappedNoFollow(path.join(privateDir, "template-lock.json"), MAX_TEMPLATE_LOCK_BYTES);
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind === "unavailable") return { kind: "unavailable", detail: "lock leaf is unreadable or unsafe" };
  return parseLockText(read.body);
}

/** Parse bounded lock JSON with exact-key and field-shape validation. */
export function parseTemplateLock(raw: unknown): TemplateLockRead {
  if (!isRecord(raw)) return malformed("lock must be an object");
  if (raw.schemaVersion === 1) return parseV1(raw);
  if (raw.schemaVersion === 2) return parseV2(raw);
  return malformed("unsupported lock schemaVersion");
}

function parseLockText(body: string): TemplateLockRead {
  try {
    return parseTemplateLock(JSON.parse(body));
  } catch {
    return malformed("lock is not valid JSON");
  }
}

function parseV1(raw: Record<string, unknown>): TemplateLockRead {
  const problem = commonProblem(raw, new Set(COMMON_KEYS), ["builtin", "local"]);
  if (problem) return malformed(problem);
  return { kind: "ok", lock: commonLock(raw, 1) as TemplateLockV1 };
}

function parseV2(raw: Record<string, unknown>): TemplateLockRead {
  const allowed = new Set<string>([...COMMON_KEYS, "remote"]);
  const problem = commonProblem(raw, allowed, ["builtin", "local", "remote"]);
  if (problem) return malformed(problem);
  const sourceType = raw.sourceType as TemplateSourceType;
  const parsed = parseOptionalRemote(raw.remote);
  if (parsed.kind === "malformed") return parsed;
  const remote = parsed.remote;
  const consistencyProblem = remoteConsistencyProblem(sourceType, remote);
  if (consistencyProblem) return malformed(consistencyProblem);
  return { kind: "ok", lock: { ...(commonLock(raw, 2) as TemplateLockV2), ...(remote ? { remote } : {}) } };
}

function parseOptionalRemote(value: unknown):
  | { kind: "ok"; remote?: RemoteTemplateProvenance }
  | { kind: "malformed"; detail: string } {
  if (value === undefined) return { kind: "ok" };
  const remote = parseRemote(value);
  return remote === null
    ? { kind: "malformed", detail: "remote provenance is malformed" }
    : { kind: "ok", remote };
}

function remoteConsistencyProblem(
  sourceType: TemplateSourceType,
  remote: RemoteTemplateProvenance | undefined,
): string | null {
  if (sourceType === "remote" && remote === undefined) return "remote source requires remote provenance";
  if (sourceType !== "remote" && remote !== undefined) return "non-remote source cannot carry remote provenance";
  return null;
}

function commonProblem(raw: Record<string, unknown>, allowed: Set<string>, sources: string[]): string | null {
  if (Object.keys(raw).some((key) => !allowed.has(key))) return "lock contains unsupported fields";
  for (const field of ["templateId", "version", "publisher", "installedAt", "profileDigest"]) {
    if (!nonEmpty(raw[field])) return `${field} must be a non-empty string`;
  }
  if (!sources.includes(String(raw.sourceType))) return "sourceType is invalid for this lock schema";
  if (!/^[0-9a-f]{64}$/.test(String(raw.profileDigest))) return "profileDigest must be lowercase SHA-256 hex";
  return null;
}

function commonLock(raw: Record<string, unknown>, schemaVersion: 1 | 2): TemplateLock {
  return {
    schemaVersion,
    templateId: raw.templateId as string,
    version: raw.version as string,
    publisher: raw.publisher as string,
    sourceType: raw.sourceType as TemplateSourceType,
    installedAt: raw.installedAt as string,
    profileDigest: raw.profileDigest as string,
  } as TemplateLock;
}

function parseRemote(value: unknown): RemoteTemplateProvenance | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !REMOTE_KEYS.includes(key as never))) return null;
  for (const field of ["coordinate", "packageDigest", "tap", "publisherKeyId", "verifiedAt"]) {
    if (!nonEmpty(value[field])) return null;
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value.packageDigest))) return null;
  if (!Number.isSafeInteger(value.indexSequence) || Number(value.indexSequence) < 0) return null;
  return value as unknown as RemoteTemplateProvenance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function malformed(detail: string): TemplateLockRead {
  return { kind: "malformed", detail };
}

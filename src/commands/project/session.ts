/**
 * @file src/commands/project/session.ts
 * @description How the `llmwiki project` commands turn a `--project <ref>` into
 * a session, and how they report a result.
 *
 * A reference is a directory (opened as the local OS user) or a host URL ending
 * in a project id (opened with a token). Nothing here resolves a principal: the
 * credential goes to the host and the host decides who is acting.
 *
 * Every command prints one JSON document and exits non-zero unless the
 * operation reached its success arm. An `unknown` outcome is reported as
 * exactly that, with the operation id to ask about, never as success.
 */

import path from "node:path";
import { PortableDenied, PortableHostError, PortableRefusal } from "../../portable/errors.js";
import { SCALE_PROTOCOL_V2 } from "../../portable/scale/contracts.js";
import { openPagedProject } from "../../portable/scale/open.js";
import type { ProjectSession } from "../../portable/project/api.js";
import type { HostModel } from "../../portable/project/runtime.js";

/** Environment variable a host or service token may be supplied through. */
const TOKEN_ENV = "LLMWIKI_PROJECT_TOKEN";

/** Result kinds that mean the command did what was asked. */
const SUCCESS_KINDS: ReadonlySet<string> = new Set([
  "committed", "proposed", "approved", "issued", "resolved",
  // The paged reads' own success arms.
  "negotiated", "page", "opened", "results",
  // The scoped journey's summary (slice S2a), and an explicit format adoption (slice S2b).
  "scoped-demo", "adopted",
  // Retained originals (slice S3): an original's metadata, a completed range read and a completed export.
  "original", "end", "completed", "originals-host-stopped",
  // The search tiers (slice S4): a triage, a promotion that proposed the finding's bytes, a full review, a stopped host.
  "triage", "promoted", "reviewed-candidates", "tiers-host-stopped",
  // The detached steps (slice S5) that advanced or reported; `settled` and `backlog-run` are judged by outcome below.
  "begun", "waiting", "ready", "status", "closed", "detached", "backlog-plan", "backlog-status", "generation",
  // The federation reads (slice S6); a group is judged by whether it completed, below.
  "links", "quality", "queue",
]);

/** Whether a detached answer settled its operation as a proposal. */
function isProposedSettlement(answer: unknown): boolean {
  const record = answer as { kind?: unknown; outcome?: { kind?: unknown } } | null;
  return record?.kind === "settled" && record.outcome?.kind === "proposed";
}

/**
 * The exit code of a detached answer judged by its outcome, or `null` for any
 * other result: a settled operation succeeded only as a proposal, a backlog
 * run only when every entry did.
 */
function detachedExitCode(record: { kind?: unknown; entries?: { result: unknown }[] }): number | null {
  if (record.kind === "settled") return isProposedSettlement(record) ? 0 : 1;
  if (record.kind === "backlog-run") return record.entries?.every((entry) => isProposedSettlement(entry.result)) ? 0 : 1;
  return null;
}

/** The protocols these commands speak. Stating the paged one changes nothing a version 1 command does. */
const PROTOCOLS = [SCALE_PROTOCOL_V2] as const;

/**
 * The model these commands run a LOCAL proposal under. `undefined` in the
 * shipped CLI, which composes none: a local `project propose` is then refused
 * with `capability_unsupported`. A composition that owns a model states it
 * once, in process, through {@link configureCommandLocalHostModel}.
 */
let commandLocalHostModel: HostModel | undefined;

/** State the model local project commands propose under, for the rest of this process. */
function configureCommandLocalHostModel(model: HostModel): void {
  commandLocalHostModel = model;
}

/** The model local project commands were composed with, if any. */
export function commandLocalHostModelOf(): HostModel | undefined {
  return commandLocalHostModel;
}

/** Options every project command accepts. */
export interface ProjectRef {
  project?: string;
  token?: string;
  service?: boolean;
}

/** Open the session a command's `--project` reference names. */
export async function openCommandSession(ref: ProjectRef): Promise<ProjectSession> {
  if (!ref.project) throw new PortableHostError("--project <ref> is required");
  if (!/^https?:\/\//u.test(ref.project)) {
    return openPagedProject({
      project: { localRoot: path.resolve(ref.project) }, credential: { kind: "local-os" }, protocols: PROTOCOLS,
      localHostModel: commandLocalHostModel,
    });
  }
  const url = new URL(ref.project);
  const token = ref.token ?? process.env[TOKEN_ENV];
  if (!token) throw new PortableHostError(`a hosted project needs --token or ${TOKEN_ENV}`);
  const project = { host: url.origin, project: url.pathname.replace(/^\/+|\/+$/gu, "") };
  const credential = ref.service
    ? { kind: "service" as const, serviceToken: token }
    : { kind: "host-token" as const, token };
  return openPagedProject({ project, credential, protocols: PROTOCOLS });
}

/** Print one JSON document. Byte arrays are shown by length, never dumped. */
function printJson(value: unknown): void {
  const replacer = (_key: string, entry: unknown): unknown =>
    entry instanceof Uint8Array ? { bytes: entry.byteLength } : entry;
  console.log(JSON.stringify(value, replacer, 2));
}

/** The exit code of a result judged by more than its kind, or `null`. */
function judgedExitCode(record: { kind?: unknown; visible?: unknown; status?: { kind?: unknown } }): number | null {
  if (record.visible === false) return 1;
  // A resolve step that left the operation parked did not resolve it.
  if (record.kind === "resolved" && record.status?.kind === "unknown") return 1;
  // A grouped change succeeded only when every entry committed.
  if (record.kind === "grouped") return (record as { complete?: unknown }).complete === true ? 0 : 1;
  return detachedExitCode(record);
}

/** The exit code a result earns: zero only for a success arm or a visible read. */
function exitCodeFor(result: unknown): number {
  if (result === null || typeof result !== "object") return 0;
  const record = result as { kind?: unknown; visible?: unknown; status?: { kind?: unknown } };
  const judged = judgedExitCode(record);
  if (judged !== null) return judged;
  return typeof record.kind === "string" && !SUCCESS_KINDS.has(record.kind) ? 1 : 0;
}

/**
 * Run one project command: print its result, or the typed failure, and return
 * the exit code. A denial says only "not found".
 */
export async function reportCommand(run: () => Promise<unknown>): Promise<number> {
  try {
    const result = await run();
    printJson(result);
    return exitCodeFor(result);
  } catch (error) {
    if (error instanceof PortableRefusal) printJson({ kind: "refused", code: error.code });
    else if (error instanceof PortableDenied) printJson({ kind: "not_found" });
    else printJson({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    return 1;
  }
}

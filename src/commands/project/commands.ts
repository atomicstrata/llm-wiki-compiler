/**
 * @file src/commands/project/commands.ts
 * @description The handlers behind `llmwiki project …`: the J1 journey as
 * commands a person can run and hand off between.
 *
 * Each handler opens a session from `--project <ref>`, calls ONE operation of
 * the logical project API and prints its result. None of them calls a legacy
 * command or `createWikiCore`: a reference that cannot be opened portably is
 * refused, never served by the legacy path.
 *
 * A write prints its operation id BEFORE it submits, so a lost response always
 * leaves something to ask `project status` about, and accepts `--operation` so
 * the same call can be repeated with the same id.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { bytesDigest } from "../../portable/digest.js";
import { registerProject } from "../../portable/index.js";
import type { ContentDigest, ResolveDecision } from "../../portable/contracts.js";
import type { ApproveRequest, WikiProject } from "../../portable/project/api.js";
import { exportToDirectory } from "./export-command.js";
import { startPortableViewer } from "../../portable/surfaces/viewer.js";
import { openCommandSession, reportCommand, type ProjectRef } from "./session.js";

/** Options shared by every write command. */
export interface WriteOptions extends ProjectRef {
  /** Repeat an earlier call under its id instead of allocating a new one. */
  operation?: string;
  supersedes?: string;
}

/** Default approval lifetime requested by the CLI; the host caps it. */
const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** The operation id for a write: the caller's, or a freshly allocated one, announced first. */
export async function operationIdFor(project: WikiProject, options: WriteOptions): Promise<string> {
  const operationId = options.operation ?? await project.allocateOperation();
  console.error(`operation: ${operationId}`);
  return operationId;
}

/** Run `action` against the project a command names. */
function withProject(ref: ProjectRef, action: (project: WikiProject) => Promise<unknown>): Promise<number> {
  return reportCommand(async () => {
    const session = await openCommandSession(ref);
    try {
      return await action(session.project);
    } finally {
      await session.close();
    }
  });
}

/** `project register [dir]` */
export function projectRegisterCommand(dir: string | undefined): Promise<number> {
  return reportCommand(async () => ({ kind: "resolved", ...(await registerProject(path.resolve(dir ?? "."))) }));
}

/** `project capabilities` */
export function projectCapabilitiesCommand(ref: ProjectRef): Promise<number> {
  return withProject(ref, (project) => project.capabilities());
}

/** `project source add <file>` */
export function projectSourceAddCommand(file: string, options: WriteOptions & { name?: string }): Promise<number> {
  return withProject(options, async (project) => {
    const bytes = await readFile(file);
    return project.sources.add({
      operationId: await operationIdFor(project, options), name: options.name ?? path.basename(file),
      upload: { bytes, byteDigest: bytesDigest(bytes) }, supersedes: options.supersedes,
    });
  });
}

/** `project propose` */
export function projectProposeCommand(options: WriteOptions): Promise<number> {
  return withProject(options, async (project) =>
    project.propose({ operationId: await operationIdFor(project, options), supersedes: options.supersedes }));
}

/** `project candidates list <proposal>` */
export function projectCandidatesListCommand(proposal: string, ref: ProjectRef): Promise<number> {
  return withProject(ref, (project) => project.candidates.list(proposal));
}

/** `project candidates show <proposal> <candidate>`: the exact draft and what it replaces. */
export function projectCandidatesShowCommand(proposal: string, candidate: string, ref: ProjectRef): Promise<number> {
  return withProject(ref, (project) => project.candidates.get(proposal, candidate));
}

/** The digests an approval must name: exactly what was reviewed. */
export interface ApproveOptions extends WriteOptions {
  candidateSet?: string;
  plan?: string;
  dependencies?: string;
  expires?: string;
}

/**
 * The approve request for `proposal` naming exactly the reviewed digests,
 * under the write's operation id. Every approve command builds it here.
 *
 * @throws Error when a reviewed digest is missing, or a retry does not repeat its expiry.
 */
export async function reviewedApproval(project: WikiProject, proposal: string, options: ApproveOptions): Promise<ApproveRequest> {
  if (!options.candidateSet || !options.plan || !options.dependencies) {
    throw new Error("approve requires --candidate-set, --plan and --dependencies: the digests that were reviewed");
  }
  // The requested expiry is part of what the request IS. A default recomputed
  // on a retry would be a different request under the same id.
  if (options.operation && !options.expires) {
    throw new Error("an approve retry under --operation must repeat the original --expires value");
  }
  const requestedExpiresAt = options.expires ?? new Date(Date.now() + DEFAULT_APPROVAL_TTL_MS).toISOString();
  console.error(`requested expiry: ${requestedExpiresAt} (repeat it with --expires to retry this call)`);
  return {
    operationId: await operationIdFor(project, options), proposalOperationId: proposal,
    candidateSetDigest: options.candidateSet as ContentDigest, planDigest: options.plan as ContentDigest,
    applyDependenciesDigest: options.dependencies as ContentDigest, supersedes: options.supersedes,
    requestedExpiresAt,
  };
}

/** `project approve <proposal>` */
export function projectApproveCommand(proposal: string, options: ApproveOptions): Promise<number> {
  return withProject(options, async (project) => project.candidates.approve(await reviewedApproval(project, proposal, options)));
}

/** `project approval show <approval>` */
export function projectApprovalShowCommand(approval: string, ref: ProjectRef): Promise<number> {
  return withProject(ref, (project) => project.approvals.get(approval));
}

/** `project apply <approval>` */
export function projectApplyCommand(approval: string, options: WriteOptions & { ticket?: string }): Promise<number> {
  return withProject(options, async (project) => project.apply({
    operationId: await operationIdFor(project, options), approvalId: approval,
    ticketId: options.ticket, supersedes: options.supersedes,
  }));
}

/** `project ticket issue <approval>` */
export function projectTicketIssueCommand(
  approval: string, options: ProjectRef & { serviceActor?: string; expires?: string },
): Promise<number> {
  return withProject(options, (project) => project.issueExecutionTicket({
    approvalId: approval, serviceActor: options.serviceActor ?? "",
    requestedExpiresAt: options.expires ?? new Date(Date.now() + DEFAULT_APPROVAL_TTL_MS).toISOString(),
  }));
}

/** `project status <operation>` */
export function projectStatusCommand(operation: string, ref: ProjectRef): Promise<number> {
  return withProject(ref, (project) => project.status(operation));
}

/** `project resolve <operation>` */
export function projectResolveCommand(
  operation: string, options: ProjectRef & { decision?: string; reason?: string },
): Promise<number> {
  return withProject(options, (project) => project.resolve({
    operationId: operation, decision: options.decision as ResolveDecision, reason: options.reason ?? "",
  }));
}

/** `project pages list` */
export function projectPagesListCommand(ref: ProjectRef): Promise<number> {
  return withProject(ref, (project) => project.pages.list());
}

/** `project pages read <id>` */
export function projectPagesReadCommand(id: string, ref: ProjectRef): Promise<number> {
  return withProject(ref, (project) => project.pages.get(id));
}

/** `project search <query>` */
export function projectSearchCommand(query: string, ref: ProjectRef): Promise<number> {
  return withProject(ref, (project) => project.search(query));
}

/** `project export --out <dir>`: see {@link exportToDirectory} for what it guarantees. */
export function projectExportCommand(options: ProjectRef & { out?: string }): Promise<number> {
  return withProject(options, async (project) => {
    if (!options.out) throw new Error("export requires --out <dir>");
    return exportToDirectory(project, path.resolve(options.out));
  });
}

/** `project deferred <operation>`: shows the typed refusal of a deferred domain. */
export function projectDeferredCommand(name: string, ref: ProjectRef): Promise<number> {
  return withProject(ref, async (project) => {
    const operation = (project.deferred as unknown as Record<string, (() => Promise<unknown>) | undefined>)[name];
    if (!operation) throw new Error(`unknown deferred operation: ${name}`);
    return operation();
  });
}

/**
 * `project view`: start the read-only portable viewer on a loopback port and
 * keep it running. Each request is authorized as the principal the host derives
 * from this command's credential.
 */
export async function projectViewCommand(options: ProjectRef & { port?: string }): Promise<number> {
  return reportCommand(async () => {
    await openCommandSession(options);
    const port = options.port === undefined ? undefined : Number(options.port);
    const viewer = await startPortableViewer(() => openCommandSession(options), { port });
    console.error(`portable viewer (read-only): ${viewer.url}`);
    await new Promise(() => undefined);
  });
}

/**
 * @file src/commands/project/federation-commands.ts
 * @description The handlers behind `llmwiki project federation …`: slice S6's
 * operator journey against a host that offers `portable-federation/2`.
 *
 * Every command names the host, the receiver project and the federation, and
 * reads the caller's credentials — their receiver token and their own token
 * for each other shard — from a JSON file given by `--credentials`. Tokens are
 * never taken from the command line and never printed. A write allocates its
 * operation id from the receiver's own version 1 session and names it on
 * stderr. Every command prints one JSON document and exits non-zero unless the
 * answer reached its success arm. There is no host or administration command:
 * a host is prepared by its owner in process.
 */

import { readFile } from "node:fs/promises";
import { PortableHostError } from "../../portable/errors.js";
import { FEDERATION_PROTOCOL_V2, type FederationSessionV2, type GroupEntryV2, type ShardCredentialV2 } from "../../portable/federation/contracts.js";
import { openFederation } from "../../portable/federation/open.js";
import { openProject } from "../../portable/index.js";
import { reportCommand } from "./session.js";

/** Options every federation command accepts. */
export interface FederationRef { host?: string; receiver?: string; federation?: string; credentials?: string }

/** What a credentials file holds. */
interface CredentialsFile { token: string; shards: ShardCredentialV2[] }

/** The caller's credentials, read from their file and checked for shape only. */
async function credentialsOf(ref: FederationRef): Promise<CredentialsFile> {
  if (!ref.credentials) throw new PortableHostError("--credentials <file> is required");
  const shape = "the credentials file must hold {token, shards}";
  const text = await readFile(ref.credentials, "utf8");
  let parsed: CredentialsFile;
  try {
    parsed = JSON.parse(text) as CredentialsFile;
  } catch {
    // A parse error quotes the file's text, and the file holds tokens: say only what shape was expected.
    throw new PortableHostError(shape);
  }
  if (typeof parsed?.token !== "string" || !Array.isArray(parsed.shards)) throw new PortableHostError(shape);
  return parsed;
}

/** The federation session the options name. */
async function sessionOf(ref: FederationRef): Promise<FederationSessionV2> {
  if (!ref.host || !ref.receiver || !ref.federation) throw new PortableHostError("--host, --receiver and --federation are required");
  const { token, shards } = await credentialsOf(ref);
  return openFederation({ receiver: { host: ref.host, project: ref.receiver, token }, federationId: ref.federation, shards, protocols: [FEDERATION_PROTOCOL_V2] });
}

/** A fresh operation id from the receiver's own version 1 session, named on stderr. */
async function operationOf(ref: FederationRef): Promise<string> {
  const { token } = await credentialsOf(ref);
  const session = await openProject({ project: { host: ref.host!, project: ref.receiver! }, credential: { kind: "host-token", token } });
  const operationId = await session.project.allocateOperation();
  console.error(`operation: ${operationId}`);
  return operationId;
}

/** `project federation search <text>` */
export function projectFederationSearchCommand(text: string, options: FederationRef & { limit?: string }): Promise<number> {
  return reportCommand(async () => (await sessionOf(options)).search({ text, limit: options.limit === undefined ? undefined : Number(options.limit) }));
}

/** `project federation links <shard> <id>` */
export function projectFederationLinksCommand(shard: string, id: string, options: FederationRef): Promise<number> {
  return reportCommand(async () => (await sessionOf(options)).links({ source: { shard, id } }));
}

/** `project federation quality`: the next default window of each shard. */
export function projectFederationQualityCommand(options: FederationRef): Promise<number> {
  return reportCommand(async () => (await sessionOf(options)).quality());
}

/** `project federation propose --slug <s> --title <t> --child <project>:<path>…` */
export function projectFederationProposeCommand(options: FederationRef & { slug: string; title: string; child: string[] }): Promise<number> {
  return reportCommand(async () => {
    const children = options.child.map((entry) => ({ project: entry.slice(0, entry.indexOf(":")), path: entry.slice(entry.indexOf(":") + 1) }));
    return (await sessionOf(options)).overview.propose({ operationId: await operationOf(options), slug: options.slug, title: options.title, children });
  });
}

/** `project federation review <proposal>`: every candidate the caller may read, in full. */
export function projectFederationReviewCommand(proposal: string, options: FederationRef): Promise<number> {
  return reportCommand(async () => {
    const session = await sessionOf(options);
    const listed = await session.overview.list(proposal);
    if (!("items" in listed)) return listed;
    const candidates = [];
    for (const summary of listed.items) {
      const view = await session.overview.get(proposal, summary.id);
      if ("visible" in view && view.visible) candidates.push(view.value);
    }
    return { kind: "reviewed-candidates", proposal, candidates };
  });
}

/** `project federation approve <proposal> --candidate <id>`: approve exactly the digests the reviewed view names. */
export function projectFederationApproveCommand(proposal: string, options: FederationRef & { candidate: string }): Promise<number> {
  return reportCommand(async () => {
    const session = await sessionOf(options);
    const view = await session.overview.get(proposal, options.candidate);
    if (!("visible" in view) || !view.visible) return view;
    const { candidateSetDigest, planDigest, applyDependenciesDigest } = view.value;
    return session.overview.approve({
      operationId: await operationOf(options), proposalOperationId: proposal, candidateSetDigest, planDigest, applyDependenciesDigest,
      requestedExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  });
}

/** `project federation apply <approval>` */
export function projectFederationApplyCommand(approval: string, options: FederationRef): Promise<number> {
  return reportCommand(async () => (await sessionOf(options)).overview.apply({ operationId: await operationOf(options), approvalId: approval }));
}

/** `project federation read <slug>` */
export function projectFederationReadCommand(slug: string, options: FederationRef): Promise<number> {
  return reportCommand(async () => (await sessionOf(options)).overview.read(slug));
}

/** `project federation queue [--cursor <c>] [--limit <n>]` */
export function projectFederationQueueCommand(options: FederationRef & { cursor?: string; limit?: string }): Promise<number> {
  return reportCommand(async () => (await sessionOf(options)).queue({ cursor: options.cursor, limit: options.limit === undefined ? undefined : Number(options.limit) }));
}

/** `project federation group --entries <file>`: entries, each with its own preallocated id, from a JSON file. */
export function projectFederationGroupCommand(options: FederationRef & { entries: string }): Promise<number> {
  return reportCommand(async () => (await sessionOf(options)).group(JSON.parse(await readFile(options.entries, "utf8")) as GroupEntryV2[]));
}

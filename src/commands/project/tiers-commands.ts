/**
 * @file src/commands/project/tiers-commands.ts
 * @description The handlers behind `llmwiki project tiers …`: slice S4's
 * operator journey against a host that offers both search tiers.
 *
 * `search` queries raw sources and truly reviewed pages together; `triage`
 * compares one source with the other cleared sources, read-only; `promote`
 * turns a finding into an ordinary scoped proposal; `review`, `approve` and
 * `apply` are the visible S2 steps that follow, each run with that person's
 * own token. These commands are clients of a host that offers the search
 * tiers; this package ships no such host, and a local directory answers with
 * a typed refusal. Every command prints one JSON document and exits non-zero unless the
 * operation reached its success arm.
 */

import { PortableHostError } from "../../portable/errors.js";
import { TIERS_PROTOCOL_V2, type TierName } from "../../portable/tiered/contracts.js";
import { openTieredProject, type TieredSessionV2 } from "../../portable/tiered/open.js";
import { tiersRefused } from "../../portable/tiered/refusals.js";
import { openCommandSession, reportCommand, type ProjectRef } from "./session.js";

/** Environment variable a host token may be supplied through. */
const TOKEN_ENV = "LLMWIKI_PROJECT_TOKEN";

/** The tier session of a hosted `--project` reference. */
function sessionOf(ref: ProjectRef): TieredSessionV2 {
  if (!ref.project || !/^https?:\/\//u.test(ref.project)) throw new PortableHostError("the search tiers need a hosted --project <url>/<project>");
  const url = new URL(ref.project);
  const token = ref.token ?? process.env[TOKEN_ENV];
  if (!token) throw new PortableHostError(`a hosted project needs --token or ${TOKEN_ENV}`);
  return openTieredProject({
    project: { host: url.origin, project: url.pathname.replace(/^\/+|\/+$/gu, "") }, credential: { kind: "host-token", token }, protocols: [TIERS_PROTOCOL_V2],
  });
}

/** A fresh operation id from the project's version 1 session. */
async function operationOf(ref: ProjectRef): Promise<string> {
  const operationId = await (await openCommandSession(ref)).project.allocateOperation();
  console.error(`operation: ${operationId}`);
  return operationId;
}

/** `project tiers search <query>`: an explicit `--limit` must be a whole number, or nothing is sent. */
export function projectTiersSearchCommand(query: string, options: ProjectRef & { tiers?: string; limit?: string }): Promise<number> {
  const tiers = options.tiers?.split(",").map((tier) => tier.trim()) as TierName[] | undefined;
  const limit = options.limit === undefined ? undefined : Number(options.limit);
  if (limit !== undefined && !Number.isInteger(limit)) return reportCommand(async () => tiersRefused("invalid_request"));
  return reportCommand(() => sessionOf(options).tiers.search({ text: query, tiers, limit }));
}

/** `project tiers triage <source>` */
export function projectTiersTriageCommand(source: string, options: ProjectRef): Promise<number> {
  return reportCommand(() => sessionOf(options).tiers.triage({ source }));
}

/** `project tiers promote <source> --digest <digest> --namespace <ns>`: succeeds only when the finding's exact bytes were proposed. */
export function projectTiersPromoteCommand(source: string, options: ProjectRef & { digest: string; namespace: string }): Promise<number> {
  return reportCommand(async () => {
    const finding = { source, digest: options.digest as `sha256:${string}` };
    const promoted = await sessionOf(options).tiers.promote({ operationId: await operationOf(options), finding, namespace: options.namespace });
    const isProposed = promoted.kind === "promoted" && promoted.proposal.kind === "proposed" && promoted.compiledFindingBytes;
    return isProposed ? promoted : { kind: "promotion-not-proposed", promoted };
  });
}

/** `project tiers review <proposal>`: every candidate of a scoped proposal, read in full. */
export function projectTiersReviewCommand(proposal: string, options: ProjectRef): Promise<number> {
  return reportCommand(async () => {
    const { review } = sessionOf(options);
    const candidates = [];
    for (const summary of (await review.candidates.list(proposal)).items) {
      const view = await review.candidates.get(proposal, summary.id);
      if (view.visible) candidates.push(view.value);
    }
    return { kind: "reviewed-candidates", proposal, candidates };
  });
}

/** `project tiers approve <proposal> --candidate <id>`: approve exactly the digests the reviewed view names. */
export function projectTiersApproveCommand(proposal: string, options: ProjectRef & { candidate: string }): Promise<number> {
  return reportCommand(async () => {
    const { review } = sessionOf(options);
    const view = await review.candidates.get(proposal, options.candidate);
    if (!view.visible) return view;
    const { candidateSetDigest, planDigest, applyDependenciesDigest } = view.value;
    return review.candidates.approve({
      operationId: await operationOf(options), proposalOperationId: proposal, candidateSetDigest, planDigest, applyDependenciesDigest,
      requestedExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  });
}

/** `project tiers apply <approval>` */
export function projectTiersApplyCommand(approval: string, options: ProjectRef): Promise<number> {
  return reportCommand(async () => sessionOf(options).review.apply({ operationId: await operationOf(options), approvalId: approval }));
}

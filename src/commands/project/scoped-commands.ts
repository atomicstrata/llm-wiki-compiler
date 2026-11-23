/**
 * @file src/commands/project/scoped-commands.ts
 * @description The handlers behind `llmwiki project format adopt` and
 * `llmwiki project scoped …`: slice S2b's explicit format-2 adoption and the
 * disk scoped journey of a registered directory, as commands.
 *
 * Adoption is its own command and prints what it costs before anything else:
 * older portable-aware binaries (verified: published 1.5.0) then refuse to
 * modify the project, and there is no downgrade. Opening a project never
 * adopts it; on a project that has not adopted, every scoped write refuses by name.
 *
 * Staleness on a directory is CONSERVATIVE, and the commands say so: a
 * proposal depends on the complete concept title list, so creating, removing
 * or editing ANY concept page stales it, as does a change to a selected
 * source, its canonical state entry, the kept-page and modifier decisions or
 * the labels of the state. An unrelated state entry does not.
 */

import path from "node:path";
import { PortableHostError } from "../../portable/errors.js";
import { DISK_CEILING_BOUNDS, DISK_SCOPED_PROTOCOL_V2, type DiskCompileScopeV2 } from "../../portable/scoped-disk/disk-contracts.js";
import { adoptProjectFormat2, openDiskScopedProject, type DiskScopedSessionV2 } from "../../portable/scoped-disk/open.js";
import { operationIdFor, reviewedApproval, type ApproveOptions, type WriteOptions } from "./commands.js";
import { commandLocalHostModelOf, type ProjectRef, reportCommand } from "./session.js";

/** What every scoped proposal's output states about its dependencies. */
const STALENESS = [
  "depends on the COMPLETE list of wiki/concepts/: creating, removing or editing any concept page stales this proposal",
  "depends on the bytes and .llmwiki/state.json entry of every source it read — the named ones AND any co-owning source admitted beside them — the kept-page and modifier decisions, and the labels of the state and its custody",
  "a source outside both the named scope and its admitted co-owner expansion does not stale it, nor does that source's state entry",
];

/** Open the registered directory a command names, stating the disk scoped protocol. */
async function openScoped(ref: ProjectRef): Promise<DiskScopedSessionV2> {
  if (!ref.project) throw new PortableHostError("--project <dir> is required");
  if (/^https?:\/\//u.test(ref.project)) throw new PortableHostError("the disk scoped path serves a registered local directory only");
  return openDiskScopedProject({
    localRoot: path.resolve(ref.project), protocols: [DISK_SCOPED_PROTOCOL_V2], localHostModel: commandLocalHostModelOf(),
  });
}

/** Run `action` against the session a command names; a stale refusal says what may have moved. */
function withScoped(ref: ProjectRef, action: (session: DiskScopedSessionV2) => Promise<unknown>): Promise<number> {
  return reportCommand(async () => {
    const session = await openScoped(ref);
    try {
      const result = await action(session);
      const isStale = (result as { code?: unknown } | null)?.code === "stale_read_set";
      return isStale ? { ...(result as object), staleness: STALENESS } : result;
    } finally {
      await session.close();
    }
  });
}

/** `project format adopt [dir]`: adopt format 2, stating the consequence first. */
export function projectFormatAdoptCommand(dir: string | undefined): Promise<number> {
  return reportCommand(async () => {
    const result = await adoptProjectFormat2(path.resolve(dir ?? "."));
    console.error(result.consequence);
    return result;
  });
}

/** `project scoped capabilities` */
export function projectScopedCapabilitiesCommand(ref: ProjectRef): Promise<number> {
  return withScoped(ref, (session) => session.scoped.negotiate());
}

/** Options of `project scoped propose`. */
export interface ScopedProposeOptions extends WriteOptions { sources?: string; maxExpanded?: string; maxCandidates?: string }

/** The declared scope of a propose command: the named sources under the disk ceilings, optionally lowered. */
function scopeOf(options: ScopedProposeOptions): DiskCompileScopeV2 {
  const names = (options.sources ?? "").split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  const bounds = { ...DISK_CEILING_BOUNDS };
  if (options.maxExpanded !== undefined) bounds.maxExpandedSources = Number(options.maxExpanded);
  if (options.maxCandidates !== undefined) bounds.maxCandidates = Number(options.maxCandidates);
  return { sources: { kind: "source-names", names }, namespace: { kind: "root-concepts" }, context: null, bounds };
}

/** `project scoped propose --sources a.md[,b.md]` */
export function projectScopedProposeCommand(options: ScopedProposeOptions): Promise<number> {
  return withScoped(options, async (session) => {
    const outcome = await session.scoped.propose({
      operationId: await operationIdFor(session.project, options), scope: scopeOf(options), supersedes: options.supersedes,
    });
    return outcome.kind === "proposed" ? { ...outcome, staleness: STALENESS } : outcome;
  });
}

/** `project scoped coverage <proposal>`: what the proposal covered, stated honestly. */
export function projectScopedCoverageCommand(proposal: string, ref: ProjectRef): Promise<number> {
  return withScoped(ref, (session) => session.scoped.coverage(proposal));
}

/** `project scoped candidates list <proposal>` */
export function projectScopedCandidatesListCommand(proposal: string, ref: ProjectRef): Promise<number> {
  return withScoped(ref, (session) => session.scoped.candidates.list(proposal));
}

/** `project scoped candidates show <proposal> <candidate>`: the exact draft and what it replaces. */
export function projectScopedCandidatesShowCommand(proposal: string, candidate: string, ref: ProjectRef): Promise<number> {
  return withScoped(ref, (session) => session.scoped.candidates.get(proposal, candidate));
}

/** `project scoped approve <proposal>`: exactly the digests that were reviewed. */
export function projectScopedApproveCommand(proposal: string, options: ApproveOptions): Promise<number> {
  return withScoped(options, async (session) => session.scoped.candidates.approve(await reviewedApproval(session.project, proposal, options)));
}

/** `project scoped apply <approval>` */
export function projectScopedApplyCommand(approval: string, options: WriteOptions): Promise<number> {
  return withScoped(options, async (session) => session.scoped.apply({
    operationId: await operationIdFor(session.project, options), approvalId: approval, supersedes: options.supersedes,
  }));
}

/** `project scoped status <source>`: where one source's canonical state stands. */
export function projectScopedStatusCommand(source: string, ref: ProjectRef): Promise<number> {
  return withScoped(ref, (session) => session.scoped.sourceStatus(source));
}

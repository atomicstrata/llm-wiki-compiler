/**
 * @file test/portable/helpers.ts
 * @description Shared fixtures for the portable-path witnesses: a registered
 * project in a temporary directory with its own host control root, and the
 * small steps of the J1 journey.
 *
 * Every path is canonicalized first, because host control state refuses a
 * control root reached through a symlink, and the system temp directory is one
 * on macOS. No provider, credential or environment file is involved: the host
 * runs the deterministic fixture model.
 */

import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bytesDigest } from "../../src/portable/digest.js";
import { vi } from "bun:test";
import { DeterministicProvider, overrideOf } from "../helpers/deterministic-provider.js";
import { LocalHostControl, registerLocalProject } from "../../src/portable/host/local-control.js";
import { openLocalProject, type LocalOpenOptions } from "../../src/portable/local.js";
import type { ApprovalOutcome, ProposalOutcome, PublicationOutcome } from "../../src/portable/contracts.js";
import type { CandidateView, PreparedUpload, ProjectSession, WikiProject } from "../../src/portable/project/api.js";
import { DiskProjectStore } from "../../src/portable/store/disk-store.js";
import type { PublishFaultStage } from "../../src/portable/store/store.js";

/** The local host model of these fixtures: a test-only provider that THROWS on any call. Nothing here generates; a test that proposes must supply its own answers. */
const NO_MODEL = () => overrideOf(new DeterministicProvider());

/** Source text the fixture model turns into one concept named "Tidal Energy". */
const TIDAL_SOURCE = "# Tidal Energy\n\nTidal energy converts the rise and fall of tides into electricity.\n";

/** Create a temporary directory tree with a project root and a control root. */
async function makeRoots(): Promise<{ base: string; root: string; controlRoot: string }> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "llmwiki-portable-")));
  const root = path.join(base, "project");
  await mkdir(root, { recursive: true });
  return { base, root, controlRoot: path.join(base, "control") };
}

/** Prepare text as a re-sendable upload with its declared digest. */
export function prepared(text: string): PreparedUpload {
  const bytes = Buffer.from(text, "utf8");
  return { bytes, byteDigest: bytesDigest(bytes) };
}

/** Add one source and require it to commit. */
async function addSource(project: WikiProject, name: string, text: string): Promise<PublicationOutcome> {
  const outcome = await project.sources.add({ operationId: await project.allocateOperation(), name, upload: prepared(text) });
  if (outcome.kind !== "committed") throw new Error(`source.add did not commit: ${JSON.stringify(outcome)}`);
  return outcome;
}

/** Propose and require a committed proposal. */
async function proposeOk(project: WikiProject): Promise<Extract<ProposalOutcome, { kind: "proposed" }>> {
  const outcome = await project.propose({ operationId: await project.allocateOperation() });
  if (outcome.kind !== "proposed") throw new Error(`propose did not commit: ${JSON.stringify(outcome)}`);
  return outcome;
}

/** Read the first candidate of a proposal in full. */
async function firstCandidate(project: WikiProject, proposalOperationId: string): Promise<CandidateView> {
  const listed = await project.candidates.list(proposalOperationId);
  const view = await project.candidates.get(proposalOperationId, listed.items[0].id);
  if (!view.visible) throw new Error("candidate not visible");
  return view.value;
}

/** Approve exactly what `view` showed. */
async function approveView(project: WikiProject, view: CandidateView): Promise<ApprovalOutcome> {
  return project.candidates.approve({
    operationId: await project.allocateOperation(), proposalOperationId: view.proposalOperationId,
    candidateSetDigest: view.candidateSetDigest, planDigest: view.planDigest,
    applyDependenciesDigest: view.applyDependenciesDigest,
    requestedExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

/** Source → propose → review → approve; returns the approval id and the reviewed view. */
async function approvedProposal(project: WikiProject): Promise<{ approvalId: string; view: CandidateView }> {
  await addSource(project, "tidal.md", TIDAL_SOURCE);
  const proposed = await proposeOk(project);
  const view = await firstCandidate(project, proposed.receipt.operationId);
  const approval = await approveView(project, view);
  if (approval.kind !== "approved") throw new Error(`approve did not commit: ${JSON.stringify(approval)}`);
  return { approvalId: approval.approval.approvalId, view };
}

/** A store option that simulates a crash at one point of the publication protocol. */
function crashAt(stage: PublishFaultStage): NonNullable<LocalOpenOptions["store"]> {
  return { faultForTest: (reached) => { if (reached === stage) throw new Error("simulated crash"); } };
}

/**
 * Make the NEXT wait for the project gate the moment every role is removed:
 * the call was authorized when it was made, and is revoked while it queues.
 */
export function revokeWhileQueued(controlRoot: string, projectId: string): void {
  // Every gate of the disk store (the ordinary one and the status-only one) waits through `gated`.
  const prototype = DiskProjectStore.prototype as unknown as { gated(fn: () => Promise<unknown>): Promise<unknown> };
  const gate = prototype.gated;
  vi.spyOn(prototype, "gated").mockImplementationOnce(async function (this: DiskProjectStore, fn: () => Promise<unknown>) {
    const control = await LocalHostControl.open(controlRoot);
    const record = (await control.loadProject(projectId))!;
    await control.saveProject({ ...record, bindings: [], policyRevision: record.policyRevision + 1 });
    return gate.call(this, fn) as never;
  });
}

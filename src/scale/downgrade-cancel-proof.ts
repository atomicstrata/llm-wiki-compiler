/**
 * @file src/scale/downgrade-cancel-proof.ts
 * @description The NO-MOVE PROOF of a fenced pre-install cancel (design v2
 * §2), read-only. Every clause refuses `scale_downgrade_not_cancellable`
 * naming itself, before anything is written.
 *
 * - P3: no archive leaf, no apply receipt, no archived `indexed` or
 *   `indexed-pins` directory in the evidence directory.
 * - P4: `.llmwiki/indexed` is in place; `indexedFacts` reports NO blocker; its
 *   stores (each manifest's SHA-256) and its pins (labels and digest) are
 *   exactly the plan's.
 * - P5: every prior is in place: the plan binds each by DIGEST and size only
 *   (it never recorded an inode identity), so that is what is checked, plus
 *   the identity the complete stage manifest bound when one exists; nothing
 *   is at its prior path and the `prior/` directory is absent or empty. The
 *   identity observed now is returned, to be captured in the cancel intent and
 *   re-checked just before the record changes.
 * - P6: no staged object is at its unit path (the evidence module already
 *   proved each is still at its staged path).
 * - P7: the evidence directory (`./downgrade-cancel-evidence.ts`).
 * The content freeze is deliberately NOT checked: an edit outside the export
 * targets is preserved, and may be the reason for cancelling.
 *
 * The barrier is INSPECTED here, never changed: a live one refuses, a stale
 * one of another plan refuses, and a stale one of this plan is reported so the
 * caller removes it only after the whole proof has passed (Root correction 2).
 */

import path from "node:path";
import { listConfinedDirBounded } from "../utils/confined-dir.js";
import { INDEXED_DIR } from "../segments/contracts.js";
import { retireFenceState } from "../segments/retire-barrier.js";
import { archivedIndexed } from "./downgrade-archive.js";
import { notCancellable, stagingEvidence } from "./downgrade-cancel-evidence.js";
import { ScaleDowngradeError } from "./downgrade-contracts.js";
import { identityAt, leafDigest, sameObject, type LeafDigest, type ObjectIdentityV1 } from "./downgrade-fs.js";
import { indexedFacts } from "./downgrade-indexed-facts.js";
import { priorPath, readArchiveLeaf, readReceipt, type PriorFileV1, type StageManifestV1 } from "./downgrade-journal.js";
import type { DowngradePlanV1 } from "./downgrade-plan.js";

/** What a passed no-move proof establishes. */
export interface NoMoveProof {
  /** Each prior as found now: digest and the identity observed. */
  readonly priors: readonly PriorFileV1[];
  /** The complete stage manifest relied on, or null. */
  readonly manifest: StageManifestV1 | null;
}

/** Inspect the barrier read-only: true when a stale barrier of THIS plan is present (to remove after the proof). */
export async function inspectBarrier(root: string, plan: string): Promise<boolean> {
  const state = await retireFenceState(root);
  if (state.kind === "blocking") throw new ScaleDowngradeError("scale_downgrade_readers_live", state.reason);
  if (state.kind === "absent") return false;
  if (state.planDigest !== plan) notCancellable("barrier", "a stale barrier of another plan is present");
  return true;
}

/** P3. */
async function assertNoArchive(root: string, dir: string, plan: DowngradePlanV1): Promise<void> {
  if ((await readArchiveLeaf(root, dir, plan.digest)) !== null) notCancellable("P3", "the archive was recorded");
  if ((await readReceipt(root, dir, plan.digest)) !== null) notCancellable("P3", "the scale-down receipt exists");
  for (const relPath of [archivedIndexed(dir), path.posix.join(dir, "indexed-pins")]) {
    if ((await identityAt(root, relPath)) !== null) notCancellable("P3", `${relPath} exists`);
  }
}

/** P4. */
async function assertIncumbentAuthority(root: string, plan: DowngradePlanV1): Promise<void> {
  if ((await identityAt(root, INDEXED_DIR))?.kind !== "directory") notCancellable("P4", `${INDEXED_DIR} is not in place`);
  const facts = await indexedFacts(root);
  if (facts.blockers.length > 0) notCancellable("P4", `the indexed stores report ${facts.blockers.map((blocker) => blocker.code).join(", ")}`);
  if (JSON.stringify(facts.stores) !== JSON.stringify(plan.inventory.stores)) notCancellable("P4", "the indexed stores are not the plan's");
  const pins = plan.inventory.pins;
  if (facts.pins.digest !== pins.digest || JSON.stringify(facts.pins.labels) !== JSON.stringify(pins.labels)) notCancellable("P4", "the pins are not the plan's");
}

/** One prior file the plan's inventory recorded. */
type PlanPrior = DowngradePlanV1["inventory"]["priors"][number];

/** A prior the plan found absent must still be absent (P5). */
function proveAbsentPrior(prior: PlanPrior, found: LeafDigest): PriorFileV1 {
  if (found.kind !== "absent") notCancellable("P5", `${prior.relPath} should be absent, as the plan found it`);
  return { relPath: prior.relPath, sha256: null, identity: null };
}

/** Whether the digested leaf is exactly the prior file the plan bound: the same digest and the same size. */
function isBoundPriorFile(found: LeafDigest, prior: PlanPrior): found is Extract<LeafDigest, { kind: "ok" }> {
  return found.kind === "ok" && found.sha256 === prior.sha256 && found.bytes === prior.bytes;
}

/** The object identity the stage manifest bound for `relPath`, or null (no manifest, or none bound). */
function boundIdentity(manifest: StageManifestV1 | null, relPath: string): ObjectIdentityV1 | null {
  return manifest?.priors.find((entry) => entry.relPath === relPath)?.identity ?? null;
}

/** One prior as proven in place now (P5). */
async function provePrior(root: string, prior: PlanPrior, manifest: StageManifestV1 | null): Promise<PriorFileV1> {
  const found = await leafDigest(root, prior.relPath);
  if (prior.sha256 === null) return proveAbsentPrior(prior, found);
  if (!isBoundPriorFile(found, prior)) return notCancellable("P5", `${prior.relPath} is not the prior file the plan bound`);
  const bound = boundIdentity(manifest, prior.relPath);
  if (bound !== null && !sameObject(found.identity, bound)) notCancellable("P5", `${prior.relPath} is not the object the stage manifest bound`);
  return { relPath: prior.relPath, sha256: prior.sha256, identity: found.identity };
}

/** P5: every prior in place, nothing retired. */
async function provePriors(root: string, dir: string, plan: DowngradePlanV1, manifest: StageManifestV1 | null): Promise<PriorFileV1[]> {
  const retired = await listConfinedDirBounded(root, path.posix.join(dir, "prior"), 1);
  if (retired.kind !== "absent" && !(retired.kind === "ok" && retired.entries.length === 0)) notCancellable("P5", `${dir}/prior is not empty: a prior file was moved aside`);
  const proven: PriorFileV1[] = [];
  for (const prior of plan.inventory.priors) {
    if ((await identityAt(root, priorPath(dir, prior.relPath))) !== null) notCancellable("P5", `${prior.relPath} was moved aside`);
    proven.push(await provePrior(root, prior, manifest));
  }
  return proven;
}

/** P6: no staged object is at its unit path. */
async function assertNothingInstalled(root: string, manifest: StageManifestV1 | null): Promise<void> {
  for (const unit of manifest?.units ?? []) {
    if (unit.staged === null) continue;
    const found = await identityAt(root, unit.relPath);
    if (found !== null && sameObject(found, unit.staged)) notCancellable("P6", `${unit.relPath} holds the staged file (installation began)`);
  }
}

/** The whole fenced no-move proof (P3 to P7); `ownLeaves` are this cancel's leaves already written. */
export async function proveNoMove(root: string, dir: string, plan: DowngradePlanV1, ownLeaves: readonly string[]): Promise<NoMoveProof> {
  const manifest = await stagingEvidence(root, dir, plan, ownLeaves);
  await assertNoArchive(root, dir, plan);
  await assertIncumbentAuthority(root, plan);
  const priors = await provePriors(root, dir, plan, manifest);
  await assertNothingInstalled(root, manifest);
  return { priors, manifest };
}

/** Refuse unless every prior is still exactly as captured (digest and the identity observed then). */
export async function assertPriorsUnchanged(root: string, captured: readonly PriorFileV1[]): Promise<void> {
  for (const prior of captured) {
    const found = await leafDigest(root, prior.relPath);
    const same = prior.sha256 === null ? found.kind === "absent"
      : found.kind === "ok" && found.sha256 === prior.sha256 && prior.identity !== null && sameObject(found.identity, prior.identity);
    if (!same) notCancellable("P5", `${prior.relPath} changed since the cancel proved it`);
  }
}

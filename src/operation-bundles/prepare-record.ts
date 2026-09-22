/** @file Internal host-authorized record preparation. Uses the existing project
 * lock, trust planner, reserved-ID staging and authenticated observer. Never
 * approves or applies. SDK request/options capture belongs to the facade. */
import { loadNonDefaultProfile } from "../profile/block.js";
import path from "node:path";
import { readConfinedLeafBuffer } from "../utils/confined-read.js";
import type { LifecycleDef } from "../profile/types.js";
import { MAX_PAYLOAD_BYTES } from "./constants.js";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { parseFrontmatter } from "../utils/markdown.js";
import { planPageMutation } from "../trust/planner.js";
import { withRecordPreparationLock } from "./record-authority.js";
import { scanOperationInventory } from "./capacity.js";
import { digestBytes, readPageDigest } from "./adapters/shared.js";
import { reserveRecordEffectLocked } from "./effect-reservation.js";
import { compileRecordDraft, recordEffectKeyBytes, recordPageMutation } from "./record-draft.js";
import { captureRecordIntent, recordIntentDigest, type RecordIntentV1 } from "./record-intent.js";
import { operationManifestDigest } from "./manifest-parse.js";
import { observeOperationBundle } from "./observe.js";
import { stageOperationBundleLocked } from "./stage.js";
import type { OperationPrincipal } from "./principal.js";
import type { OperationBundleManifest, OperationDigest, PageOperationMutation } from "./types.js";

/** Exact prepared identity; neither this reference nor caller origin conveys approval. */
export type PreparedEffectRefV1 = { workspaceId: string; effectId: string; intentDigest: OperationDigest;
  bundleId: string; operationRunId: string; manifestDigest: OperationDigest };

/** Locate a previously materialized effect even if its allocation index disappeared. */
async function existingEffect(root: string, principal: OperationPrincipal, intent: RecordIntentV1) {
  const inventory = await scanOperationInventory(root);
  if (inventory.problems.length) throw new Error("record-preparation-unavailable");
  const keyDigest = digestBytes(recordEffectKeyBytes(intent, principal.id));
  const matching = inventory.manifests.filter(manifest => manifest.workspaceId === intent.workspaceId &&
    manifest.createdBy === principal.id && manifest.preparationEvidence.some(item => item.type === "record-effect-key-v1" && item.digest === keyDigest));
  if (matching.length > 1) throw new Error("record-preparation-unavailable");
  const existing = matching[0];
  if (existing && !existing.preparationEvidence.some(item => item.type === "record-intent-v1" && item.digest === digestBytes(canonicalBytes(intent)))) {
    throw new Error("effect-intent-conflict");
  }
  return existing;
}

/** Reuse requires a verified run, not just a manifest left by interrupted staging. */
async function preparedReference(root: string, intent: RecordIntentV1, manifest: OperationBundleManifest): Promise<PreparedEffectRefV1> {
  const manifestDigest = operationManifestDigest(manifest) as OperationDigest;
  const observation = await observeOperationBundle(root, manifestDigest);
  if (observation.status !== "observed") throw new Error("record-preparation-unavailable");
  return { workspaceId: intent.workspaceId, effectId: intent.effectId, intentDigest: recordIntentDigest(intent),
    bundleId: manifest.bundleId, operationRunId: manifest.runId, manifestDigest };
}

/** Validate current domain state; preparation cannot publish or bypass profile checks. */
async function validateRecord(root: string, intent: RecordIntentV1): Promise<string> {
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded || `sha256:${loaded.digest}` !== intent.profileDigest) throw new Error("record-profile-drift");
  const entity = loaded.profile.entities[intent.target.entityType];
  if (!entity) throw new Error("record-target-invalid");
  if (entity.lifecycle) await validateInitialLifecycle(root, intent, entity.lifecycle);
  await validatePreimage(root, intent);
  const plan = await planPageMutation({ root, target: { kind: "entity", ...intent.target }, body: intent.proposedBody,
    origin: "operation", reviewRouted: false, allowOverwrite: intent.precondition.kind === "digest" });
  if (!["allow", "allow-with-warning"].includes(plan.decision) || plan.planned.length !== 1) throw new Error("record-target-refused");
  return loaded.profile.profileId;
}

/** Compare the exact declared preimage without treating unreadable bytes as absence. */
async function validatePreimage(root: string, intent: RecordIntentV1): Promise<void> {
  const mutation = recordPageMutation(intent) as PageOperationMutation;
  const current = await readPageDigest(root, mutation);
  if (current.kind === "unavailable") throw new Error("record-preimage-unavailable");
  if (intent.precondition.kind === "absent" ? current.kind !== "absent"
    : current.kind !== "ok" || current.digest !== intent.precondition.digest) throw new Error("record-preimage-drift");
}

/** The primitive edits initial-state records only; it cannot publish or reset a lifecycle. */
async function validateInitialLifecycle(root: string, intent: RecordIntentV1, lifecycle: LifecycleDef): Promise<void> {
  if (parseFrontmatter(intent.proposedBody).meta[lifecycle.field] !== lifecycle.initial) {
    throw new Error("record-lifecycle-transition-unsupported");
  }
  if (intent.precondition.kind === "absent") return;
  const parent = path.join(root, "wiki", intent.target.entityType);
  const read = await readConfinedLeafBuffer(root, path.join(parent, `${intent.target.slug}.md`), parent,
    MAX_PAYLOAD_BYTES, { requireSingleLink: true });
  if (read.kind !== "ok" || digestBytes(read.body) !== intent.precondition.digest) throw new Error("record-preimage-drift");
  if (parseFrontmatter(read.body.toString("utf8")).meta[lifecycle.field] !== lifecycle.initial) {
    throw new Error("record-lifecycle-transition-unsupported");
  }
}

/** Capture before IO, require explicit prepare authority, and serialize with operator apply. */
export async function prepareRecordEffect(root: string, principal: OperationPrincipal, input: unknown): Promise<PreparedEffectRefV1> {
  const intent = captureRecordIntent(input);
  return withRecordPreparationLock(root, principal, async actor => {
    const existing = await existingEffect(root, actor, intent);
    if (existing) return await preparedReference(root, intent, existing);
    const profileId = await validateRecord(root, intent);
    const reservation = await reserveRecordEffectLocked(root, actor.id, intent);
    const compiled = compileRecordDraft(intent, actor, profileId);
    const staged = await stageOperationBundleLocked(root, { ...compiled,
      reservedIds: { bundleId: reservation.bundleId, runId: reservation.runId }, clock: { now: () => new Date(reservation.createdAt) } });
    return await preparedReference(root, intent, staged.manifest);
  });
}

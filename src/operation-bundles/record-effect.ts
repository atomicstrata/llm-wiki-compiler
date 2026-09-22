/** @file Exact record-effect observation and never-started retirement. The
 * immutable manifest and HMAC run, not the allocation index, authenticate the
 * effect. Retirement serializes against apply and never compensates a write. */
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { assertBundleId, assertOperationRunId } from "./ids.js";
import { assertWorkspaceId } from "./paths.js";
import { digest, textValue } from "./manifest-values.js";
import { dataRecord, captureRecordIntent, recordIntentDigest } from "./record-intent.js";
import { readOperationManifest } from "./manifest-store.js";
import { operationManifestDigest } from "./manifest-parse.js";
import { readBundlePayload, digestBytes } from "./adapters/shared.js";
import { recordEffectKeyBytes, recordPageMutation } from "./record-draft.js";
import { observeOperationBundle, type OperationBundleObservationV1 } from "./observe.js";
import { readOperationRun, appendOperationTransitionLocked } from "./run-store.js";
import { operationRunPredecessor } from "./run-integrity.js";
import { withRecordPreparationLock } from "./record-authority.js";
import type { OperationPrincipal } from "./principal.js";
import { operationNeverStarted } from "./never-started.js";
import type { PreparedEffectRefV1 } from "./prepare-record.js";
import type { OperationBundleManifest } from "./types.js";

/** Capture the closed reference without accepting authority or path selectors. */
export function capturePreparedEffect(value: unknown): PreparedEffectRefV1 {
  const input = dataRecord(value, ["workspaceId", "effectId", "intentDigest", "bundleId", "operationRunId", "manifestDigest"]);
  return { workspaceId: assertWorkspaceId(input.workspaceId), effectId: textValue(input.effectId, "effectId"),
    intentDigest: digest(input.intentDigest, "intentDigest"), bundleId: assertBundleId(input.bundleId),
    operationRunId: assertOperationRunId(input.operationRunId), manifestDigest: digest(input.manifestDigest, "manifestDigest") };
}

/** Re-read exact retained intent bytes and bind them to every advertised coordinate. */
async function resolveRecordEffect(root: string, ref: PreparedEffectRefV1) {
  const read = await readOperationManifest(root, ref.workspaceId, assertBundleId(ref.bundleId));
  if (read.status !== "ok") throw new Error("record-effect-unavailable");
  const manifest = read.manifest;
  if (manifest.runId !== ref.operationRunId || operationManifestDigest(manifest) !== ref.manifestDigest) throw new Error("record-effect-binding-mismatch");
  await verifyManifestIntent(root, ref, manifest);
  const observation = await observeOperationBundle(root, ref.manifestDigest);
  if (observation.status !== "observed" || observation.binding.workspaceId !== ref.workspaceId ||
    observation.binding.runId !== ref.operationRunId || observation.binding.bundleId !== ref.bundleId) throw new Error("record-effect-unavailable");
  return { manifest, observation };
}

/** Bind retained intent and host-key bytes to the exact declared page mutation. */
async function verifyManifestIntent(root: string, ref: PreparedEffectRefV1, manifest: OperationBundleManifest): Promise<void> {
  const bytes = await effectEvidence(root, manifest, "record-intent-v1");
  const intent = captureRecordIntent(JSON.parse(bytes.toString("utf8")));
  if (!canonicalBytes(intent).equals(bytes) || intent.workspaceId !== ref.workspaceId || intent.effectId !== ref.effectId ||
    recordIntentDigest(intent) !== ref.intentDigest) throw new Error("record-effect-binding-mismatch");
  if (manifest.mutations.length !== 1 || manifest.knowledgeAuthority.digest !== intent.profileDigest) throw new Error("record-effect-binding-mismatch");
  const { index: _index, mutationId: _mutationId, ...mutation } = manifest.mutations[0]!;
  if (!canonicalBytes(mutation).equals(canonicalBytes(recordPageMutation(intent)))) throw new Error("record-effect-binding-mismatch");
  const keyBytes = await effectEvidence(root, manifest, "record-effect-key-v1");
  if (!keyBytes.equals(recordEffectKeyBytes(intent, manifest.createdBy))) throw new Error("record-effect-binding-mismatch");
}

/** Evidence declarations alone are insufficient: rehash the retained payload itself. */
async function effectEvidence(root: string, manifest: OperationBundleManifest, type: string): Promise<Buffer> {
  const evidence = manifest.preparationEvidence.filter(item => item.type === type);
  if (evidence.length !== 1 || !evidence[0]!.payloadRef) throw new Error("record-effect-binding-mismatch");
  const item = evidence[0]!, payload = await readBundlePayload(root, manifest.workspaceId, manifest.bundleId, item.payloadRef!);
  if (payload.kind !== "ok" || payload.bytes.length !== item.byteCount || digestBytes(payload.bytes) !== item.digest) {
    throw new Error("record-effect-unavailable");
  }
  return payload.bytes;
}

/** Read-only exact-effect receipt; unavailable observations never imply no effect. */
export async function observeRecordEffect(root: string, input: unknown): Promise<OperationBundleObservationV1> {
  try { return (await resolveRecordEffect(root, capturePreparedEffect(input))).observation; }
  catch { return { status: "unavailable", detail: "record effect observation unavailable" }; }
}

/** Retire only this host's pre-effect bundle under the same lock used by apply. */
export async function retireRecordEffect(root: string, principal: OperationPrincipal, input: unknown): Promise<OperationBundleObservationV1> {
  const ref = capturePreparedEffect(input);
  return withRecordPreparationLock(root, principal, async actor => {
    const resolved = await resolveRecordEffect(root, ref);
    if (resolved.manifest.createdBy !== actor.id) throw new Error("record-preparer-mismatch");
    const read = await readOperationRun(root, resolved.observation.binding);
    if (read.status !== "ok" || !operationNeverStarted(read.run)) throw new Error("record-retirement-refused");
    if (read.run.state === "superseded") return resolved.observation;
    if (!["awaiting-approval", "approved", "approval-invalidated"].includes(read.run.state)) throw new Error("record-retirement-refused");
    await appendOperationTransitionLocked(root, resolved.observation.binding, operationRunPredecessor(read.run),
      { type: "superseded", stateAfter: "superseded", payload: { kind: "none" }, actor, at: new Date().toISOString() });
    return await observeRecordEffect(root, ref);
  });
}

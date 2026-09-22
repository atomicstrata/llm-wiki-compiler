/**
 * @file Immutable allocation of record-effect bundle identities. The service must
 * hold the project lock, validate host authority/profile/preimage, and check the
 * operation inventory before calling. This is preparation indexing, not a run
 * journal: it cannot approve, apply, retire or certify settlement. Reservations
 * are retained indefinitely in this prototype; no automatic reclamation exists.
 */
import path from "node:path";
import { lstat } from "node:fs/promises";
import { canonicalBytes, canonicalDigest } from "../profile/templates/signing/canonical.js";
import { atomicWriteNoReplaceDurable } from "../utils/atomic-write.js";
import { durableTempPath, durableWritingPath } from "../utils/atomic-write-no-replace-durable.js";
import { readDurableOperationLeafBuffer } from "./durable-leaf.js";
import { assertBundleId, assertOperationRunId, mintBundleId, mintOperationRunId, type BundleId, type OperationRunId } from "./ids.js";
import { digest, exact, record, textValue, timestamp } from "./manifest-values.js";
import { recordIntentDigest, type RecordIntentV1 } from "./record-intent.js";
import type { OperationDigest } from "./types.js";

const MAX_RESERVATION_BYTES = 8192;
type EffectKey = { workspaceId: string; preparerId: string; effectId: string };

/** Core-owned IDs and timestamp keep materialization stable after interrupted staging. */
export type EffectReservation = EffectKey & { schema: "llmwiki-effect-reservation-v1";
  intentDigest: OperationDigest; bundleId: BundleId; runId: OperationRunId; createdAt: string };

/** Dedicated core index sits outside run inventory; no request supplies its path. */
function reservationPath(root: string, key: EffectKey) {
  const parent = path.join(root, ".llmwiki", "operation-effect-reservations");
  const id = canonicalDigest({ domain: "llmwiki.effect-reservation.v1", ...key }).slice(7);
  return { parent, file: path.join(parent, `${id}.json`) };
}

/** Decode bounded canonical storage and validate every identity before reuse. */
function parseReservation(bytes: Buffer, key: EffectKey): EffectReservation {
  const value = record(JSON.parse(bytes.toString("utf8")), "reservation");
  exact(value, ["schema", "workspaceId", "preparerId", "effectId", "intentDigest", "bundleId", "runId", "createdAt"]);
  if (value.schema !== "llmwiki-effect-reservation-v1" || value.workspaceId !== key.workspaceId ||
    value.preparerId !== key.preparerId || value.effectId !== key.effectId) throw new Error("effect-reservation-unavailable");
  const parsed: EffectReservation = { ...key, schema: "llmwiki-effect-reservation-v1",
    intentDigest: digest(value.intentDigest, "intentDigest"), bundleId: assertBundleId(value.bundleId),
    runId: assertOperationRunId(value.runId), createdAt: timestamp(value.createdAt) };
  if (!canonicalBytes(parsed).equals(bytes)) throw new Error("effect-reservation-unavailable");
  return parsed;
}

/** An interrupted create has an uncertain identity; never replace it with fresh IDs. */
async function requireNoPartialReservation(file: string): Promise<void> {
  for (const companion of [durableTempPath(file), durableWritingPath(file)]) {
    try { await lstat(companion); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("effect-reservation-unavailable");
    }
    throw new Error("effect-reservation-unavailable");
  }
}

/** Reserve once under the project lock. Any uncertain write is propagated, not retried. */
export async function reserveRecordEffectLocked(root: string, preparerId: string, intent: RecordIntentV1): Promise<EffectReservation> {
  const key = { workspaceId: intent.workspaceId, effectId: intent.effectId, preparerId: textValue(preparerId, "preparerId") };
  const intentDigest = recordIntentDigest(intent), location = reservationPath(root, key);
  const read = await readDurableOperationLeafBuffer(root, location.file, location.parent, MAX_RESERVATION_BYTES);
  if (read.kind === "ok") {
    const existing = parseReservation(read.body, key);
    if (existing.intentDigest !== intentDigest) throw new Error("effect-intent-conflict");
    return existing;
  }
  if (read.kind !== "absent") throw new Error("effect-reservation-unavailable");
  await requireNoPartialReservation(location.file);
  const reservation: EffectReservation = { ...key, schema: "llmwiki-effect-reservation-v1", intentDigest,
    bundleId: mintBundleId(), runId: mintOperationRunId(), createdAt: new Date().toISOString() };
  await atomicWriteNoReplaceDurable(location.file, canonicalBytes(reservation), { confineRoot: root, exactParent: true });
  return reservation;
}

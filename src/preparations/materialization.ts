/**
 * @file src/preparations/materialization.ts
 * @description The materialization boundary of the preparation execution runner
 * (runner design v3 §§3.5, 5): the total result type a pack materializer
 * returns, its synchronous trust-boundary capture, the canonical
 * `preparation-handoff-materialization-v1` manifest, and the exactly-one
 * classification restart depends on.
 *
 * THE CAPTURE IS THE CONTROL, NOT THE TYPES. Pack code implements the
 * materializer, and `Omit<OperationRunDraft, "actor">` erases at runtime — so
 * `captureMaterializationResult` deep-captures the ENTIRE result through the
 * hardened `deepCaptureData` primitive (accessors, proxies, functions and
 * foreign prototypes refused at every level; buffers copied; result frozen)
 * BEFORE any await, then exact-key validates every record the materialization
 * schema owns. A smuggled `actor`, an unknown key at any owned level, or a
 * getter anywhere is a typed refusal — never an ignored extra, never a
 * reference the pack can mutate after return.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT VALIDATE: the semantic interior of
 * `targets[].draft`, `proposals`, `reconciliations`, `selections` and
 * `completeness`. Those shapes are owned by the intent compiler and its
 * existing authenticators (`assertProposalAuthentic`,
 * `assertReconciliationAuthentic`, `assertSelectionDecisionAuthentic`,
 * `assertCompletenessPermitsSuccess`), which run downstream on every handoff.
 * Re-encoding their key sets here would create a second enumeration that can
 * drift from the authority — the capture guarantees data-only isolation, the
 * compiler guarantees meaning.
 */

import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../capability-providers/ids.js";
import type { Sha256Digest } from "../capability-providers/types.js";
import {
  RuntimeCaptureError, captureDenseArray, captureExactRecord, deepCaptureData,
} from "../utils/runtime-capture.js";
import type { PreparationEvidenceRef } from "../operation-bundles/types.js";
import { assertBundleId, type BundleId } from "../operation-bundles/ids.js";
import type { EvidenceRefV1 } from "./types.js";

/** The evidence `kind` under which exactly one manifest per run is persisted. */
export const MATERIALIZATION_MANIFEST_KIND = "preparation-handoff-materialization-v1";

/** Closed roles a materialized payload object may carry. */
const MATERIALIZED_PAYLOAD_ROLES = Object.freeze([
  "input-bytes", "proposal-payload", "identity-set", "target-payload",
] as const);

/**
 * One separately stored CAS object the manifest references by BARE hex digest —
 * the evidence store's key form, not the prefixed `sha256:` operation form.
 * The bundle-side `PreparationEvidenceRef.digest === \`sha256:${digest}\``
 * equation in `toOperationEvidenceRef` is where the two forms meet.
 */
export interface MaterializedPayloadRefV1 {
  readonly role: (typeof MATERIALIZED_PAYLOAD_ROLES)[number];
  readonly digest: string;
  readonly byteCount: number;
  readonly mediaType: string;
}

/** Milestone A operation-bound units the materializer may map bounds onto. */
const OPERATION_BOUND_UNITS = Object.freeze(["bytes", "count", "milliseconds"] as const);

/**
 * The complete data-only result one materializer call returns (design §5).
 *
 * `operationRun` deliberately has NO actor member: the signed identity is
 * core-stamped from the host-resolved operation principal at finalization, and
 * the capture below refuses an `actor` key rather than dropping it.
 */
export interface MaterializationResultV1 {
  readonly targets: readonly Readonly<Record<string, unknown>>[];
  readonly proposals: readonly unknown[];
  readonly reconciliations: readonly unknown[];
  readonly selections: readonly unknown[];
  readonly completeness: unknown;
  readonly requiredProposalIds?: readonly string[];
  readonly authorityInputs: readonly Readonly<Record<string, unknown>>[];
  readonly authorityBounds: readonly Readonly<Record<string, unknown>>[];
  readonly operationRun: Readonly<Record<string, unknown>>;
  readonly payloadRefs: readonly MaterializedPayloadRefV1[];
  /**
   * The prior handoff bundle this preparation supersedes (Chunk 3 unit G). The
   * editorial pack supplies it; the runner threads it into the handoff request so
   * the bundle records its superseding local intent. Validated as a `bnd_` id at
   * capture — the one trust boundary for this untrusted materializer field.
   */
  readonly supersedesBundleId?: BundleId;
  /**
   * Run-content completion warnings, mapped by the materializer from its own
   * completeness derivation (`toRunCompletionWarning`) — the deficit identity
   * lists behind them exist only at derivation time, so the record alone
   * cannot reproduce them and finalization attaches these as supplied.
   */
  readonly completionWarnings?: readonly Readonly<Record<string, unknown>>[];
}

/** The persisted manifest: the captured body plus core-stamped identity. */
export interface PreparationHandoffMaterializationV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof MATERIALIZATION_MANIFEST_KIND;
  readonly runId: string;
  readonly handlerContractDigest: Sha256Digest;
  readonly grantDigest: Sha256Digest;
  readonly actor: Readonly<Record<string, unknown>>;
  readonly body: MaterializationResultV1;
}

/**
 * The materializer's way of saying THERE IS NOTHING TO PROPOSE — distinct from
 * every failure, and the reason it is a type rather than a message.
 *
 * A terminal that declared zero drafts cannot produce a Milestone A obligation:
 * an obligation over nothing is not an obligation, and coercing an empty bundle
 * would hand an operator a digest attesting to no mutation. But refusing the RUN
 * makes "your wiki is already in the proposed state" look identical to "the
 * materializer broke", and a workflow whose whole contract is idempotence — seed
 * a catalog, re-seed it, expect a no-op — cannot tell an operator the truth
 * through a refusal. So the run settles on its own arm and the surfaces report
 * success with nothing done.
 */
export class NoObligationError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "NoObligationError";
  }
}

/** Typed refusal every materialization-boundary failure resolves to. */
export class MaterializationCaptureError extends Error {
  constructor(readonly at: string, cause?: unknown) {
    super(`materialization result refused at ${at}`);
    this.name = "MaterializationCaptureError";
    this.cause = cause;
  }
}

/** Generous item caps: far above legitimate shapes, bounding hostile ones. */
const MAX_MATERIALIZED_ITEMS = 10_000;

const RESULT_REQUIRED_KEYS = Object.freeze([
  "targets", "proposals", "reconciliations", "selections", "completeness",
  "authorityInputs", "authorityBounds", "operationRun", "payloadRefs",
] as const);

/** The result-level keys that may legitimately be absent. */
const RESULT_OPTIONAL_KEYS = Object.freeze(["requiredProposalIds", "completionWarnings", "supersedesBundleId"] as const);

/**
 * Capture one untrusted materializer result: deep data-only copy first
 * (synchronous — no pack-owned reference and no accessor survives), then
 * exact-key validation of every record this schema owns.
 */
export function captureMaterializationResult(value: unknown): MaterializationResultV1 {
  let data: Readonly<Record<string, unknown>>;
  try {
    data = deepCaptureData(value) as Readonly<Record<string, unknown>>;
  } catch (cause) {
    throw new MaterializationCaptureError("result", cause);
  }
  const record = exactResult(data);
  const captured: MaterializationResultV1 = Object.freeze({
    targets: capturedArray(record.targets, "targets", capturedTarget),
    proposals: capturedArray(record.proposals, "proposals", (item) => item),
    reconciliations: capturedArray(record.reconciliations, "reconciliations", (item) => item),
    selections: capturedArray(record.selections, "selections", (item) => item),
    completeness: record.completeness,
    ...(record.requiredProposalIds === undefined ? {} : {
      requiredProposalIds: capturedArray(record.requiredProposalIds, "requiredProposalIds", capturedString),
    }),
    ...(record.completionWarnings === undefined ? {} : {
      completionWarnings: capturedArray(record.completionWarnings, "completionWarnings", capturedWarning),
    }),
    ...(record.supersedesBundleId === undefined ? {} : {
      supersedesBundleId: assertBundleId(capturedString(record.supersedesBundleId, "supersedesBundleId")),
    }),
    authorityInputs: capturedArray(record.authorityInputs, "authorityInputs", capturedAuthorityInput),
    authorityBounds: capturedArray(record.authorityBounds, "authorityBounds", capturedAuthorityBound),
    operationRun: capturedOperationRun(record.operationRun),
    payloadRefs: capturedArray(record.payloadRefs, "payloadRefs", capturedPayloadRef),
  });
  assertJsonRepresentable(captured, "result");
  return captured;
}

/**
 * Refuse any value JSON cannot faithfully carry: `bigint` (which
 * `deepCaptureData` legitimately admits but `JSON.stringify` throws on — an
 * untyped fault escaping a boundary whose contract is a typed refusal) and
 * `undefined` (which serialization silently DROPS on records and converts to
 * `null` in arrays, and which also let an unknown key ride through the
 * exact-key check as an invisible-but-present member). Running over the WHOLE
 * captured result keeps the writer and parser symmetric: capture admits
 * nothing the JSON parse side cannot reproduce.
 */
function assertJsonRepresentable(value: unknown, path: string): void {
  if (value === undefined || typeof value === "bigint") throw new MaterializationCaptureError(path);
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonRepresentable(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) assertJsonRepresentable(item, `${path}.${key}`);
}

/** Exact-key the result record, tolerating only the one optional member. */
function exactResult(data: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const present = Object.keys(data);
  const allowed = new Set<string>([...RESULT_REQUIRED_KEYS, ...RESULT_OPTIONAL_KEYS]);
  const unknown = present.find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new MaterializationCaptureError(`result.${unknown}`);
  const missing = RESULT_REQUIRED_KEYS.find((key) => !present.includes(key));
  if (missing !== undefined) throw new MaterializationCaptureError(`result.${missing} (missing)`);
  return data;
}

/** Capture one bounded dense array, wrapping refusals with their path. */
function capturedArray<T>(
  value: unknown, at: string, item: (entry: unknown, path: string) => T,
): readonly T[] {
  try {
    return captureDenseArray(value, MAX_MATERIALIZED_ITEMS, (entry, index) => item(entry, `${at}[${index}]`));
  } catch (cause) {
    if (cause instanceof MaterializationCaptureError) throw cause;
    throw new MaterializationCaptureError(at, cause);
  }
}

/** A target envelope: exact keys; the draft interior is compiler authority. */
function capturedTarget(entry: unknown, path: string): Readonly<Record<string, unknown>> {
  const record = exactKeys(entry, path, ["logicalIdentity", "draft"], ["dependsOnLogicalIdentities"]);
  capturedString(record.logicalIdentity, `${path}.logicalIdentity`);
  if (record.dependsOnLogicalIdentities !== undefined) {
    capturedArray(record.dependsOnLogicalIdentities, `${path}.dependsOnLogicalIdentities`, capturedString);
  }
  return record;
}

/**
 * One Milestone A input ref decision. Mirrors the manifest parser's rules for
 * the identical shape (`operation-bundles/manifest-parse.ts` `parseInput`,
 * module-private there): string id/provenance, prefixed digests, and the
 * selected input's rationale obligation — a selection without a recorded
 * rationale digest is an unauditable authority decision.
 */
function capturedAuthorityInput(entry: unknown, path: string): Readonly<Record<string, unknown>> {
  const record = exactKeys(entry, path, ["id", "provenance", "digest", "byteCount", "selected"], ["rationaleDigest"]);
  capturedString(record.id, `${path}.id`);
  capturedString(record.provenance, `${path}.provenance`);
  capturedDigest(record.digest, `${path}.digest`);
  if (typeof record.selected !== "boolean") throw new MaterializationCaptureError(`${path}.selected`);
  requireCount(record.byteCount, `${path}.byteCount`);
  if (record.rationaleDigest !== undefined) capturedDigest(record.rationaleDigest, `${path}.rationaleDigest`);
  if (record.selected === true && record.rationaleDigest === undefined) {
    throw new MaterializationCaptureError(`${path}.rationaleDigest (required by selected)`);
  }
  return record;
}

/** One Milestone A bound: name, closed unit, safe non-negative maximum. */
function capturedAuthorityBound(entry: unknown, path: string): Readonly<Record<string, unknown>> {
  const record = exactKeys(entry, path, ["name", "unit", "maximum"], []);
  capturedString(record.name, `${path}.name`);
  if (!(OPERATION_BOUND_UNITS as readonly unknown[]).includes(record.unit)) {
    throw new MaterializationCaptureError(`${path}.unit`);
  }
  requireCount(record.maximum, `${path}.maximum`);
  return record;
}

/**
 * The actor-less operation-run draft. An `actor` key here is the signed
 * identity a pack tried to choose, and exact-key refuses it by construction.
 */
function capturedOperationRun(value: unknown): Readonly<Record<string, unknown>> {
  return exactKeys(value, "operationRun", ["declaredCompensatorIndexes", "controlTransitionAllowance"], []);
}

/** One run-content completion warning: exact keys, counted fields. */
function capturedWarning(entry: unknown, path: string): Readonly<Record<string, unknown>> {
  const record = exactKeys(entry, path, ["code", "attempted", "completed", "skipped", "failed"], []);
  capturedString(record.code, `${path}.code`);
  for (const key of ["attempted", "completed", "skipped", "failed"] as const) {
    requireCount(record[key], `${path}.${key}`);
  }
  return record;
}

/** One payload ref: closed role, canonical digest, bounded count, media type. */
function capturedPayloadRef(entry: unknown, path: string): MaterializedPayloadRefV1 {
  const record = exactKeys(entry, path, ["role", "digest", "byteCount", "mediaType"], []);
  if (!(MATERIALIZED_PAYLOAD_ROLES as readonly unknown[]).includes(record.role)) {
    throw new MaterializationCaptureError(`${path}.role`);
  }
  requireCount(record.byteCount, `${path}.byteCount`);
  if (typeof record.mediaType !== "string" || record.mediaType.length === 0) {
    throw new MaterializationCaptureError(`${path}.mediaType`);
  }
  return Object.freeze({
    role: record.role as MaterializedPayloadRefV1["role"],
    digest: capturedBareDigest(record.digest, `${path}.digest`),
    byteCount: record.byteCount as number,
    mediaType: record.mediaType,
  });
}

/** Exact-key one nested record, naming the offending path on refusal. */
function exactKeys(
  value: unknown, path: string, required: readonly string[], optional: readonly string[],
): Readonly<Record<string, unknown>> {
  const record = value as Readonly<Record<string, unknown>> | null;
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new MaterializationCaptureError(path);
  }
  const present = Object.keys(record).filter((key) => record[key] !== undefined);
  try {
    captureExactRecord(
      Object.fromEntries(present.map((key) => [key, record[key]])),
      [...required, ...optional.filter((key) => present.includes(key))],
    );
  } catch (cause) {
    throw new MaterializationCaptureError(path, cause);
  }
  return record;
}

/** The evidence store's bare CAS key: exactly 64 lowercase hex characters. */
const BARE_SHA256_HEX = /^[0-9a-f]{64}$/;

/** Require one bare lowercase 64-hex CAS digest (evidence-store key form). */
function capturedBareDigest(value: unknown, path: string): string {
  if (typeof value !== "string" || !BARE_SHA256_HEX.test(value)) {
    throw new MaterializationCaptureError(path);
  }
  return value;
}

/** Require one prefixed `sha256:` canonical digest (operation/contract form). */
function capturedDigest(value: unknown, path: string): Sha256Digest {
  try {
    return parseSha256Digest(value);
  } catch (cause) {
    throw new MaterializationCaptureError(path, cause);
  }
}

/** Require one safe non-negative integer. */
function requireCount(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new MaterializationCaptureError(path);
  }
}

/** Require one non-empty string. */
function capturedString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new MaterializationCaptureError(path);
  return value;
}

/** Serialize one manifest to its canonical, deterministic byte form. */
export function serializeMaterializationManifest(manifest: PreparationHandoffMaterializationV1): Buffer {
  return Buffer.from(canonicalBytes(manifest));
}

const MANIFEST_KEYS = Object.freeze([
  "schemaVersion", "kind", "runId", "handlerContractDigest", "grantDigest", "actor", "body",
] as const);

/**
 * Parse persisted manifest bytes back into the manifest, through the SAME
 * capture the finalization writer used — one parser, no drift (design §5).
 */
export function parseMaterializationManifest(bytes: Buffer): PreparationHandoffMaterializationV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf-8"));
  } catch (cause) {
    throw new MaterializationCaptureError("manifest", cause);
  }
  let record: Readonly<Record<string, unknown>>;
  try {
    record = captureExactRecord(deepCaptureData(raw), [...MANIFEST_KEYS]);
  } catch (cause) {
    if (cause instanceof RuntimeCaptureError) throw new MaterializationCaptureError("manifest", cause);
    throw cause;
  }
  if (record.schemaVersion !== 1) throw new MaterializationCaptureError("manifest.schemaVersion");
  if (record.kind !== MATERIALIZATION_MANIFEST_KIND) throw new MaterializationCaptureError("manifest.kind");
  return Object.freeze({
    schemaVersion: 1,
    kind: MATERIALIZATION_MANIFEST_KIND,
    runId: capturedString(record.runId, "manifest.runId"),
    handlerContractDigest: capturedDigest(record.handlerContractDigest, "manifest.handlerContractDigest"),
    grantDigest: capturedDigest(record.grantDigest, "manifest.grantDigest"),
    actor: exactActor(record.actor),
    body: captureMaterializationResult(record.body),
  });
}

/** The core-stamped actor: id, surface, grants — the operation-principal shape. */
function exactActor(value: unknown): Readonly<Record<string, unknown>> {
  return exactKeys(value, "manifest.actor", ["id", "surface", "grants"], []);
}

/**
 * Convert one run-attached evidence ref into the bundle's vocabulary (design
 * §5). The two shapes are DIFFERENT TYPES with different digest grammars:
 * `EvidenceRefV1` carries kind/provenanceLabel and a prefixed digest, the
 * bundle's `PreparationEvidenceRef` carries type/provenance and gains a
 * `payloadRef` only when the bare hex of its digest is a known payload CAS
 * key — under the exact `digest === \`sha256:${payloadRef}\`` equation, never
 * a guess. This is the single crossing point between the vocabularies.
 */
export function toOperationEvidenceRef(
  ref: EvidenceRefV1,
  payloadDigests: ReadonlySet<string>,
): PreparationEvidenceRef {
  const bare = ref.digest.startsWith("sha256:") ? ref.digest.slice("sha256:".length) : null;
  const isPayload = bare !== null && payloadDigests.has(bare);
  return {
    type: ref.kind, provenance: ref.provenanceLabel, digest: ref.digest as PreparationEvidenceRef["digest"],
    byteCount: ref.byteCount, ...(isPayload && bare !== null ? { payloadRef: bare as PreparationEvidenceRef["payloadRef"] } : {}),
  };
}

/** The exactly-one classification restart depends on (design §3.5). */
export type MaterializationManifestClassification =
  | { readonly status: "none" }
  | { readonly status: "one"; readonly ref: EvidenceRefV1 }
  | { readonly status: "multiple"; readonly count: number };

/**
 * Classify a run's evidence refs by manifest kind. Zero is not-finalized, one
 * is the manifest, more than one is an integrity refusal the caller must
 * surface — NEVER resolved by picking the newest, because "newest" is exactly
 * the axis an attacker or a replayed crash can control.
 */
export function classifyMaterializationManifests(
  refs: readonly EvidenceRefV1[],
): MaterializationManifestClassification {
  const manifests = refs.filter((ref) => ref.kind === MATERIALIZATION_MANIFEST_KIND);
  if (manifests.length === 0) return { status: "none" };
  if (manifests.length === 1) return { status: "one", ref: manifests[0] };
  return { status: "multiple", count: manifests.length };
}

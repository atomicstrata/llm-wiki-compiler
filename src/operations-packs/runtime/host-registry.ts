/**
 * @file src/operations-packs/runtime/host-registry.ts
 * @description The EXECUTABLE per-run host-handler registry (design section 16.1,
 * WOP V3 slice 3C). Slice 3A delivered the six PURE families and a drift-refusing
 * descriptor resolver whose `execute` could only fail closed with
 * `host-handler-runtime-unavailable`; this module is the runtime that binds them,
 * so a compiled pack action's host-handler phase actually computes and publishes
 * output evidence instead of settling every phase `failed`.
 *
 * IT REUSES 3A's RESOLVER RATHER THAN RESTATING IT. `resolve(ref)` delegates to
 * {@link createHostHandlerRegistry} for the descriptor, so the unknown-id,
 * version-drift, and contract-digest-drift refusals stay in ONE place; only the
 * handler is replaced. A second copy of the descriptor table is exactly how a
 * phase could be sealed against one contract and dispatched against another.
 *
 * DISPATCH IS BY PHASE INSTANCE, NOT BY REF. `resolve(ref)` receives no logical
 * phase, and two phases of one action legitimately share a family — so the ref
 * cannot select a body. The invocation carries `phaseInstanceId`, and the
 * registry precomputes `phaseInstanceId → compiled binding` from the run's
 * manifest digest at construction. A phase instance with no compiled binding is a
 * fixed-code failure, never a guess.
 *
 * WHAT IT EXECUTES AND WHAT IT REFUSES. All six families compute. A phase's
 * evidence is the UNION of its bound inputs, in binding order: an
 * `initial-input` binding contributes the decoded frozen action input, and a
 * `phase-output` binding contributes the items its SINGLE-expansion predecessor
 * published — resolved lock-free off the durable run (the summary's output
 * digest into the evidence CAS), which is safe because a settled phase's
 * committed output is immutable. `reconcile` additionally reads the
 * CURRENT-STORE snapshot its body's `comparedEvidenceClass` names, through
 * {@link packStoreSnapshot} — and an unreadable profile or page, or a compared
 * class that is not a DECLARED entity type, REFUSES the phase, because a
 * partial or vacuously-empty snapshot would report an existing page `absent`.
 * `render-template` walks the closed template the COMPILER resolved onto the
 * compiled action (an unknown templateRef refused before any run staged), and
 * republishes its rendered output as one wrapped evidence item so a successor
 * consumes the projection through the ordinary phase-output convention. What
 * cannot be resolved is REFUSED with fixed codes rather than approximated,
 * because a substitute would produce a WRONG answer rather than no answer: a
 * non-single predecessor expansion, a predecessor with no committed output, and
 * an output publishing no decodable item list all refuse.
 *
 * IT NEVER WRITES AUTHORITATIVE EVIDENCE. A family's result is canonicalized and
 * written to a host-owned scratch file under `os.tmpdir()`; `admitHostHandlerLeg`
 * copies it into temporary custody and the attempt commit publishes it into the
 * preparation evidence CAS under the project lock.
 */

import { isDataRecord, scalarFields, isEvidenceScalar } from "./evidence-scalars.js";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalBytes } from "../../profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../../capability-providers/ids.js";
import { derivePhaseInstanceId, singleExpansionIdentity } from "../../preparations/ids.js";
import { readPreparationEvidenceBytes } from "../../preparations/evidence-store.js";
import { readPreparationRun } from "../../preparations/run-store.js";
import type { NormalizedPhaseV1, PhaseExecutorV1, PhaseInputBindingV1 } from "../../preparations/plan-types.js";
import type { PreparationRunBinding } from "../../preparations/run-types.js";
import type { Sha256Digest } from "../../preparations/types.js";
import type {
  AttemptClockV1, HostHandlerInvocationV1, HostHandlerRefV1, HostHandlerResolutionV1,
  HostHandlerResultV1, PreparationHostHandlerRegistryV1,
} from "../../preparations/attempts/types.js";
import type { CompiledPackActionV1, CompiledPhaseBindingV1 } from "../compiler-types.js";
import { assembleContext } from "../handlers/context-assemble.js";
import { compileIntents } from "../handlers/intent-compile.js";
import { evaluateRules } from "../handlers/rule-evaluate.js";
import { reconcileEvidence } from "../handlers/reconcile.js";
import { renderTemplate } from "../handlers/render-template.js";
import { decodeProviderResponse, type ProviderOutputFieldV1 } from "../handlers/provider-response.js";

import { enforceOutputBytes } from "../handlers/evidence.js";
import { createHostHandlerRegistry } from "../handlers/registry.js";
import { selectSet } from "../handlers/set-select.js";
import { packStoreSnapshot } from "./store-snapshot.js";
import type { ReconcilePhaseBodyV2 } from "../recipe-types.js";
import { PackHostHandlerError } from "../handlers/types.js";
import type {
  PackEvidenceItemV1, PackEvidenceScalarV1, PackHandlerBoundsV1, PackHostIdentitiesV1,
} from "../handlers/types.js";
import { RESERVED_EVIDENCE_ITEM_ID } from "../constants.js";
import { PackDeferredError } from "../problems.js";

/** The sealed executor of a phase whose work a capability provider performs. */
type ProviderCapabilityExecutorV1 = Extract<PhaseExecutorV1, { kind: "provider-capability" }>;


/**
 * THE evidence-decoding convention for an `action-input` bound phase, stated
 * once. The run's frozen initial input set is ONE canonical JSON object of the
 * action's resolved input fields. An ALL-SCALAR input decodes to exactly ONE
 * evidence item under this stable identity whose `fields` are those fields; an
 * input carrying `string-list` fields is MULTI-SOURCE and decodes to one item
 * per list entry, zipped by index under positional `source-<i>` identities —
 * see {@link zipSourceItems} for the column/frame rule.
 */
const ACTION_INPUT_ITEM_ID = RESERVED_EVIDENCE_ITEM_ID;

/** The positional identity prefix of one zipped multi-source input item. */
const SOURCE_ITEM_ID_PREFIX = "source-";

/** The media type every family result is canonicalized and published under. */
const OUTPUT_MEDIA_TYPE = "application/json";

/** The fixed problem codes this runtime fails closed with; never caller text. */
const PROBLEM = Object.freeze({
  unknownPhase: "pack-phase-not-bound",
  phaseOutputInput: "pack-phase-output-input-deferred",
  listInput: "pack-input-field-unrepresentable",
  listMismatch: "pack-input-list-length-mismatch",
  inputUndecodable: "pack-action-input-undecodable",
  familyDeferred: "pack-family-runtime-deferred",
  familyRefused: "pack-family-refused",
  outputUnwritable: "pack-output-unwritable",
  snapshotUnavailable: "pack-store-snapshot-unavailable",
  templateUnresolved: "pack-render-template-unresolved",
});

/** The run-scoped identities the intent family binds; never invented here. */
export interface PackHostRuntimeDepsV1 {
  /** The staged manifest digest every phase-instance identity is derived from. */
  readonly manifestDigest: Sha256Digest;
  /** The durable preparation run this registry executes for. */
  readonly runId: string;
  /** The host principal driving the run, as `host-identity` mappings see it. */
  readonly principal: string;
  /** The host clock a `host-timestamp` mapping and rule freshness windows read. */
  readonly clock: AttemptClockV1;
  /** The project root a `phase-output` binding reads predecessor evidence from. */
  readonly root: string;
  /** The durable run binding the predecessor's committed evidence is located by. */
  readonly binding: PreparationRunBinding;
}

/** One compiled phase resolved to everything its execution reads. */
interface BoundPhaseV1 {
  readonly binding: CompiledPhaseBindingV1;
  readonly inputBindings: readonly PhaseInputBindingV1[];
}

/** One family computation: its result, or the fixed-code refusal that stopped it. */
type FamilyOutcomeV1 =
  | { readonly kind: "ok"; readonly result: unknown }
  | { readonly kind: "refused"; readonly problem: string; readonly detail: string };

/** Build a fixed-code refusal; the message never carries a caller-chosen value. */
function refused(problem: string, detail: string): FamilyOutcomeV1 {
  return { kind: "refused", problem, detail };
}

/** Project one refusal onto the closed host-handler failure result. */
function failure(problem: string, detail: string): HostHandlerResultV1 {
  return { kind: "failed", problem, detail };
}

/**
 * Index every compiled work phase by the phase-instance identity the runner will
 * derive for it. The derivation is the SAME primitive the runner and the attempt
 * executor use, so a mismatch is impossible rather than merely unlikely.
 */
function indexByPhaseInstance(
  action: CompiledPackActionV1, manifestDigest: Sha256Digest,
): ReadonlyMap<string, BoundPhaseV1> {
  const phases = new Map(action.plan.phases.map((phase) => [phase.logicalPhaseId, phase]));
  const index = new Map<string, BoundPhaseV1>();
  for (const binding of action.phaseBindings) {
    const phase = phases.get(binding.logicalPhaseId);
    if (phase === undefined) continue;
    const phaseInstanceId = derivePhaseInstanceId({
      manifestDigest, logicalPhaseId: binding.logicalPhaseId,
      expansionIdentity: singleExpansionIdentity(),
    });
    index.set(phaseInstanceId, { binding, inputBindings: phase.inputBindings });
  }
  return index;
}



/**
 * Decode the run's frozen initial input set into bounded evidence.
 *
 * The SEALED BYTES are the source, not the compiler's in-memory value object:
 * those bytes are what `plan.initialInputSet` content-addresses and what staging
 * materialized, so the evidence a family reads is provably the run's own input.
 * A list-valued field is REFUSED rather than flattened — {@link PackEvidenceScalarV1}
 * has no list arm, and joining or truncating one would silently change what the
 * pack declared.
 */
function decodeActionInput(bytes: Buffer): FamilyOutcomeV1 | { kind: "evidence"; evidence: readonly PackEvidenceItemV1[] } {
  const outcome = splitSealedInput(bytes);
  if (outcome.kind !== "split") return outcome;
  if (Object.keys(outcome.split.lists).length === 0) {
    return { kind: "evidence", evidence: [{ itemId: ACTION_INPUT_ITEM_ID, fields: outcome.split.scalars }] };
  }
  return zipSourceItems(outcome.split);
}

/**
 * Parse and split the sealed action input ONCE for every consumer: the item
 * decoder above and the render frame below both read this, so "what the input's
 * scalar fields are" cannot fork between an executing phase and a projection.
 */
function splitSealedInput(bytes: Buffer): FamilyOutcomeV1 | { kind: "split"; split: SplitInputFieldsV1 } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return refused(PROBLEM.inputUndecodable, "the frozen action input is not valid JSON");
  }
  if (!isDataRecord(parsed)) return refused(PROBLEM.inputUndecodable, "the frozen action input is not a field record");
  const split = splitInputFields(parsed);
  if (split === null) return refused(PROBLEM.listInput, "the frozen action input has a field that is not a closed evidence scalar or scalar list");
  return { kind: "split", split };
}

/** The sealed input's fields split into its scalar frame and its list columns. */
interface SplitInputFieldsV1 {
  readonly scalars: Record<string, PackEvidenceScalarV1>;
  readonly lists: Record<string, readonly PackEvidenceScalarV1[]>;
}

/** Split sealed input fields into scalars and scalar lists, or null on any other shape. */
function splitInputFields(record: Record<string, unknown>): SplitInputFieldsV1 | null {
  const scalars: Record<string, PackEvidenceScalarV1> = {};
  const lists: Record<string, readonly PackEvidenceScalarV1[]> = {};
  for (const [fieldId, value] of Object.entries(record)) {
    if (isEvidenceScalar(value)) scalars[fieldId] = value;
    else if (Array.isArray(value) && value.every(isEvidenceScalar)) lists[fieldId] = value;
    else return null;
  }
  return { scalars, lists };
}

/**
 * The reconcile leg: take the current-store snapshot, resolve the compiled
 * action's projection, and compare.
 *
 * The projection comes from the COMPILED action, never a fresh lookup, so a run
 * can only ever apply one the plan digest was sealed against — the same rule
 * render templates follow.
 */
async function reconcileFamily(
  binding: { readonly body: ReconcilePhaseBodyV2 },
  evidence: readonly PackEvidenceItemV1[],
  bounds: PackHandlerBoundsV1,
  action: CompiledPackActionV1,
  deps: { readonly root: string },
): Promise<FamilyOutcomeV1> {
  const snapshot = await packStoreSnapshot(deps.root, binding.body.comparedEvidenceClass);
  if (snapshot.kind === "refused") return refused(PROBLEM.snapshotUnavailable, snapshot.detail);
  const ref = binding.body.projectionRef;
  const projection = ref === undefined ? undefined : action.projections[ref];
  if (ref !== undefined && projection === undefined) {
    return refused(PROBLEM.templateUnresolved, `projection ${ref} is not carried by the compiled action`);
  }
  return { kind: "ok", result: reconcileEvidence({
    body: binding.body, proposed: evidence, snapshot: snapshot.items, bounds,
    ...(projection === undefined ? {} : { projection }),
  }) };
}


/**
 * Zip a MULTI-SOURCE action input into one evidence item per source record.
 *
 * A `string-list` input field is a COLUMN: entry i of every list field belongs
 * to source record i, so all list fields must agree on length — a mismatch is
 * a refusal, never a truncation, because dropping the tail of one column would
 * silently reassign values across records. Scalar fields are the FRAME and copy
 * onto every item (the same frame semantics the render family gives the action
 * input). Identities are positional (`source-<i>`), stable because both the
 * executing phase and the materializer derive them from the same sealed bytes.
 * An all-scalar input never reaches here and keeps its single `action-input`
 * item byte-identically.
 */
function zipSourceItems(split: SplitInputFieldsV1): FamilyOutcomeV1 | { kind: "evidence"; evidence: readonly PackEvidenceItemV1[] } {
  const lengths = new Set(Object.values(split.lists).map((list) => list.length));
  if (lengths.size > 1) {
    return refused(PROBLEM.listMismatch, "the frozen action input's list fields do not agree on length");
  }
  const count = [...lengths][0] ?? 0;
  const evidence: PackEvidenceItemV1[] = [];
  for (let index = 0; index < count; index += 1) {
    const fields: Record<string, PackEvidenceScalarV1> = { ...split.scalars };
    for (const [fieldId, list] of Object.entries(split.lists)) fields[fieldId] = list[index]!;
    evidence.push({ itemId: `${SOURCE_ITEM_ID_PREFIX}${index}`, fields });
  }
  return { kind: "evidence", evidence };
}

/**
 * The evidence item identities one `action-input` bound phase is EXPECTED to
 * work over, decoded from the run's frozen initial input bytes through the SAME
 * {@link decodeActionInput} the executing phase reads them with.
 *
 * The materializer needs this to derive completeness `planned` from the input
 * the run was sealed against rather than from the drafts that happened to
 * survive — a set derived from the survivors can never show a deficit, so it
 * would report a handler that produced nothing as complete. Exporting the
 * decoder's own answer rather than restating the convention is what keeps the
 * expected set and the executed set provably the same enumeration.
 *
 * @param bytes - The run's frozen initial input set bytes.
 * @returns The decoded item identities in source order, or `null` when the
 *   bytes are not a decodable action input (the same refusal the phase takes).
 */
export function actionInputItemIdentities(bytes: Buffer): readonly string[] | null {
  const decoded = decodeActionInput(bytes);
  return decoded.kind === "evidence" ? decoded.evidence.map((item) => item.itemId) : null;
}

/** The published-output convention a chainable predecessor phase carries. */
const OUTPUT_ITEMS_KEY = "items";

/**
 * The SCALAR frame of the run's sealed action input, for a caller rendering a
 * template outside a render phase. It is the same split the executing render
 * phase reads, so a request rendered from it cannot disagree with one a phase
 * would have produced from the same input.
 */
export function actionInputFrame(
  action: CompiledPackActionV1,
): Readonly<Record<string, PackEvidenceScalarV1>> {
  const split = splitSealedInput(action.initialInput.bytes);
  return split.kind === "split" ? split.split.scalars : {};
}

/** Validate one published item as a closed evidence item: an itemId and scalar fields. */
function decodeEvidenceItem(value: unknown): PackEvidenceItemV1 | null {
  if (!isDataRecord(value) || typeof value.itemId !== "string" || value.itemId.length === 0) return null;
  if (!isDataRecord(value.fields)) return null;
  const fields = scalarFields(value.fields);
  return fields === null ? null : { itemId: value.itemId, fields };
}

/**
 * Decode a predecessor phase's published output into the evidence items a
 * successor reads. A chainable family publishes its result items under `items`
 * (set-select does); a family that publishes no such list, or a malformed item,
 * is REFUSED rather than approximated — an empty or coerced set would silently
 * change what the successor was declared to work over.
 */
function predecessorOutputItems(
  bytes: Buffer,
): FamilyOutcomeV1 | { kind: "evidence"; evidence: readonly PackEvidenceItemV1[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return refused(PROBLEM.inputUndecodable, "a predecessor output is not valid JSON");
  }
  const items = (parsed as Record<string, unknown> | null)?.[OUTPUT_ITEMS_KEY];
  if (!Array.isArray(items)) {
    return refused(PROBLEM.phaseOutputInput, "a predecessor output publishes no item list to chain");
  }
  const evidence: PackEvidenceItemV1[] = [];
  for (const item of items) {
    const decoded = decodeEvidenceItem(item);
    if (decoded === null) return refused(PROBLEM.phaseOutputInput, "a predecessor output item is not a closed evidence item");
    evidence.push(decoded);
  }
  return { kind: "evidence", evidence };
}

/**
 * The item identities a chainable predecessor output publishes, decoded through
 * the SAME rule a successor reads them with. The materializer derives completeness
 * `planned` for a chained terminal phase from this rather than from the action
 * input, so the two completeness authorities stay independent.
 *
 * The predecessor's EXECUTOR is required rather than optional because "the same
 * rule" is the whole point of this helper: a provider predecessor publishes its
 * own answer, and a caller that omitted the executor would silently fall back to
 * the pack-native decode and derive a different identity set than the phase
 * actually consumed. Completeness would then be measured against a set nothing
 * produced.
 *
 * @param bytes - A predecessor phase's published output evidence bytes.
 * @param executor - The predecessor's sealed executor, or undefined when it has
 *   none.
 * @returns The published item identities, or `null` when the bytes carry no
 *   decodable item list (the same refusal a successor phase takes).
 */
/** The reconcile handler's own disposition field on a compared item. */
const RECONCILE_FINDING_FIELD = "finding-class";

/** One predecessor item: its identity and whether a comparison DISPOSITIONED it. */
export interface PredecessorItemRecordV1 {
  readonly itemId: string;
  /**
   * True when the item carries a reconcile finding other than `absent` — the
   * comparison the plan declared decided the store already holds it. Such an
   * item is deliberately SKIPPED by an absent-gated terminal, and completeness
   * must count it as skipped rather than as a required deficit: refusing a run
   * because deduplication WORKED would make every partially-novel ingest fail.
   */
  readonly dispositioned: boolean;
}

/** The published items with their reconcile dispositions, or null as above. */
export function predecessorOutputItemRecords(
  bytes: Buffer, executor: PhaseExecutorV1 | undefined,
): readonly PredecessorItemRecordV1[] | null {
  const decoded = executor?.kind === "provider-capability"
    ? providerOutputItems(bytes, executor, "predecessor")
    : predecessorOutputItems(bytes);
  if (decoded.kind !== "evidence") return null;
  return decoded.evidence.map((item) => {
    const finding = item.fields[RECONCILE_FINDING_FIELD];
    return { itemId: item.itemId, dispositioned: typeof finding === "string" && finding !== "absent" };
  });
}

/** The scalar kinds a sealed provider output field may be decoded as. */
const PROVIDER_SCALAR_KINDS = new Set(["string", "integer", "number", "boolean"]);

/**
 * Decode a PROVIDER predecessor's published output. A provider publishes its own
 * answer, not the pack's evidence envelope, so it is decoded against the schema
 * the plan SEALED for that phase rather than against the pack-native shape — the
 * one path where the bytes a successor chains from were authored outside the
 * runtime.
 *
 * A field the plan declares with a non-scalar kind is refused rather than
 * skipped: a provider cannot author an evidence reference, and quietly dropping
 * the field would hand the successor a narrower item than the plan promised.
 */
function providerOutputItems(
  bytes: Buffer, executor: ProviderCapabilityExecutorV1, sourcePhaseId: string,
): FamilyOutcomeV1 | { kind: "evidence"; evidence: readonly PackEvidenceItemV1[] } {
  // A plan sealed before provider output contracts existed carries no schema.
  // Decoding against a default would admit whatever the provider chose to send,
  // which is precisely the widening the seal exists to prevent.
  if (executor.outputSchema === undefined || executor.maximumOutputItems === undefined) {
    return refused(PROBLEM.phaseOutputInput,
      `provider phase ${sourcePhaseId} sealed no output contract to decode its answer against`);
  }
  const fields: ProviderOutputFieldV1[] = [];
  for (const field of executor.outputSchema) {
    if (!PROVIDER_SCALAR_KINDS.has(field.valueKind)) {
      return refused(PROBLEM.phaseOutputInput,
        `provider phase ${sourcePhaseId} declares field ${field.fieldId} as ${field.valueKind}, which a provider cannot author`);
    }
    fields.push({ fieldId: field.fieldId, valueKind: field.valueKind as ProviderOutputFieldV1["valueKind"] });
  }
  try {
    return { kind: "evidence",
      evidence: decodeProviderResponse(bytes, fields, { maximumItems: executor.maximumOutputItems }) };
  } catch (error) {
    return refused(PROBLEM.phaseOutputInput,
      `provider phase ${sourcePhaseId} output is undecodable: ${(error as Error).message}`);
  }
}

/**
 * Resolve one `phase-output` binding to its predecessor's published items. The
 * predecessor's committed output is immutable once its phase settled, so this
 * lock-free content-addressed read is stable; a missing summary, digest, or bytes
 * is a fixed-code refusal, never an empty-evidence substitution. A non-`single`
 * predecessor expansion is out of this slice's scope and refused by name.
 */
async function resolvePhaseOutput(
  deps: PackHostRuntimeDepsV1, action: CompiledPackActionV1, binding: PhaseInputBindingV1,
): Promise<FamilyOutcomeV1 | { kind: "evidence"; evidence: readonly PackEvidenceItemV1[] }> {
  const sourcePhaseId = binding.sourcePhaseId;
  if (sourcePhaseId === undefined) return refused(PROBLEM.phaseOutputInput, `binding ${binding.bindingId} names no source phase`);
  const source = action.plan.phases.find((phase) => phase.logicalPhaseId === sourcePhaseId);
  if (source === undefined) return refused(PROBLEM.phaseOutputInput, `binding ${binding.bindingId} names an unknown source phase`);
  if (source.expansion.kind !== "single") return refused(PROBLEM.phaseOutputInput, `source phase ${sourcePhaseId} is not a single expansion`);
  const published = await publishedOutputBytes(deps, source, sourcePhaseId);
  if (!("bytes" in published)) return published;
  return source.executor?.kind === "provider-capability"
    ? providerOutputItems(published.bytes, source.executor, sourcePhaseId)
    : predecessorOutputItems(published.bytes);
}

/** Read one settled predecessor's published output bytes off durable state. */
async function publishedOutputBytes(
  deps: PackHostRuntimeDepsV1, source: NormalizedPhaseV1, sourcePhaseId: string,
): Promise<FamilyOutcomeV1 | { readonly bytes: Buffer }> {
  const instanceId = derivePhaseInstanceId({
    manifestDigest: deps.manifestDigest, logicalPhaseId: sourcePhaseId, expansionIdentity: singleExpansionIdentity(),
  });
  const read = await readPreparationRun(deps.root, deps.binding);
  if (read.status !== "ok") return refused(PROBLEM.phaseOutputInput, `predecessor run for ${sourcePhaseId} is unreadable`);
  const summary = read.run.phaseSummaries.find((entry) => entry.phaseInstanceId === instanceId);
  if (summary?.outputEvidenceDigest === undefined) return refused(PROBLEM.phaseOutputInput, `phase ${sourcePhaseId} published no output evidence`);
  const digest = summary.outputEvidenceDigest;
  const bare = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
  const bytes = await readPreparationEvidenceBytes(deps.root,
    { workspaceId: deps.binding.workspaceId, preparationId: deps.binding.preparationId },
    bare, source.bounds.maximumOutputEvidenceBytes);
  if (bytes.status !== "ok") return refused(PROBLEM.phaseOutputInput, `predecessor evidence for ${sourcePhaseId} is ${bytes.status}`);
  return { bytes: bytes.bytes };
}

/**
 * Resolve one phase's input evidence. A phase with no `phase-output` binding reads
 * the frozen action input exactly as before; a phase that binds a predecessor
 * output reads the UNION of the action input (when also bound) and each named
 * predecessor's published items, in binding order.
 */
async function evidenceFor(
  bound: BoundPhaseV1, action: CompiledPackActionV1, deps: PackHostRuntimeDepsV1,
): Promise<FamilyOutcomeV1 | { kind: "evidence"; evidence: readonly PackEvidenceItemV1[] }> {
  const phaseOutputs = bound.inputBindings.filter((binding) => binding.sourceKind === "phase-output");
  if (phaseOutputs.length === 0) return decodeActionInput(action.initialInput.bytes);
  const evidence: PackEvidenceItemV1[] = [];
  if (bound.inputBindings.some((binding) => binding.sourceKind === "initial-input")) {
    const decoded = decodeActionInput(action.initialInput.bytes);
    if (decoded.kind !== "evidence") return decoded;
    evidence.push(...decoded.evidence);
  }
  for (const binding of phaseOutputs) {
    const resolved = await resolvePhaseOutput(deps, action, binding);
    if (resolved.kind !== "evidence") return resolved;
    evidence.push(...resolved.evidence);
  }
  return { kind: "evidence", evidence };
}

/**
 * Render one bound render phase through its COMPILE-RESOLVED template. The
 * template comes off the compiled action — the compiler refused any unknown
 * templateRef, so an absent entry here is a fixed-code failure, never a lookup
 * against a second registry that could disagree with what the plan sealed. The
 * FRAME is the sealed action input's SCALAR fields in every mode — derived
 * through the one decoder split, so a multi-source (list) input keeps its
 * shared frame even though no `action-input` item exists; the ITEMS are every
 * bound evidence item (what an `each` loop iterates). The result is republished WITH
 * a one-item `items` list wrapping the rendered output, so a successor phase
 * can consume the projection through the same phase-output convention as any
 * other family — no render-specific chaining mechanism exists.
 */
function renderFamily(
  binding: Extract<CompiledPhaseBindingV1, { family: "render-template" }>,
  evidence: readonly PackEvidenceItemV1[], bounds: PackHandlerBoundsV1, action: CompiledPackActionV1,
): FamilyOutcomeV1 {
  const template = action.renderTemplates[binding.body.templateRef];
  if (template === undefined) {
    return refused(PROBLEM.templateUnresolved, `render template ${binding.body.templateRef} is not carried by the compiled action`);
  }
  // The frame is the sealed input's SCALAR fields via the one decoder split —
  // NOT the presence of an `action-input` item, which a multi-source (list)
  // input never produces. Scalars are the shared frame by construction: the
  // zip copies them onto every source item, so a top-level field node renders
  // the same value in both modes.
  const frameSplit = splitSealedInput(action.initialInput.bytes);
  if (frameSplit.kind !== "split") return frameSplit;
  const rendered = renderTemplate({ body: binding.body, template, frame: frameSplit.split.scalars, items: evidence, bounds });
  const wrapped = {
    ...rendered,
    items: [{ itemId: binding.logicalPhaseId, fields: { output: rendered.output, "format-id": rendered.formatId } }],
  };
  // The phase's output ceiling binds what this family PUBLISHES — the wrapped
  // record, not the handler's unwrapped result. Enforcing it here keeps the
  // refusal where the contract lives: a near-ceiling render refuses as this
  // family's own bounds refusal instead of surfacing later as a recustody
  // failure in the admission leg.
  enforceOutputBytes(wrapped, bounds.maximumOutputBytes);
  return { kind: "ok", result: wrapped };
}

/**
 * Dispatch one bound phase to its registered pure family. The `family`/`body`
 * pairing is type-closed by {@link CompiledPhaseBindingV1}, so a body can never
 * reach the wrong family, and the six arms are total over the closed union.
 * Only the reconcile arm awaits: its snapshot is a store read, and an unreadable
 * store is a refusal, never an empty comparison set.
 */
async function computeFamily(
  binding: CompiledPhaseBindingV1, evidence: readonly PackEvidenceItemV1[],
  bounds: PackHandlerBoundsV1, deps: PackHostRuntimeDepsV1, action: CompiledPackActionV1,
): Promise<FamilyOutcomeV1> {
  if (binding.family === "context-assemble") return { kind: "ok", result: assembleContext({ body: binding.body, evidence, bounds }) };
  if (binding.family === "set-select") return { kind: "ok", result: selectSet({ body: binding.body, primary: evidence, bounds }) };
  if (binding.family === "rule-evaluate") return { kind: "ok", result: evaluateRules({ body: binding.body, evidence, clock: deps.clock, bounds }) };
  if (binding.family === "render-template") return renderFamily(binding, evidence, bounds, action);
  if (binding.family === "reconcile") return reconcileFamily(binding, evidence, bounds, action, deps);
  return { kind: "ok", result: compileIntents({
    body: binding.body, evidence: uniqueByItemId(evidence), identities: hostIdentities(deps), bounds,
    projections: action.projections,
  }) };
}

/**
 * One identity is ONE item for the INTENT family, stated where the drafts are
 * made. A both-source terminal can receive the same item twice — once from the
 * action input and once through a predecessor that passed it along — and the
 * union `evidenceFor` builds deliberately preserves duplicates, because
 * `set-select` needs them (its `dedupe` operation is the pack's explicit tool
 * for exactly that). But intent drafts one mutation per item, and two drafts
 * for one identity is two mutations for one target — so intent collapses to
 * the FIRST arrival of each identity, which is byte-for-byte the rule the
 * materializer's `planned` set applies (a Set keeps first insertion). The
 * check and the executor thus count the same items, and a both-bound terminal
 * hands off one draft instead of refusing over a self-collision.
 */
function uniqueByItemId(evidence: readonly PackEvidenceItemV1[]): readonly PackEvidenceItemV1[] {
  const seen = new Set<string>();
  return evidence.filter((item) => (seen.has(item.itemId) ? false : (seen.add(item.itemId), true)));
}

/** The closed host-derived identities an intent field mapping may bind (16.7). */
function hostIdentities(deps: PackHostRuntimeDepsV1): PackHostIdentitiesV1 {
  return { runId: deps.runId, principal: deps.principal, hostTimestamp: deps.clock.now() };
}

/**
 * The family bounds: the phase's declared item ceiling, and the TIGHTER of its
 * declared output ceiling and the sealed invocation ceiling. Taking the minimum
 * is fail-closed — the sealed phase bound is authority the leg enforces anyway,
 * and exceeding it would only turn a family success into an admission failure.
 */
function boundsFor(bound: BoundPhaseV1, invocation: HostHandlerInvocationV1): PackHandlerBoundsV1 {
  return {
    maximumItems: bound.binding.bounds.maximumItems,
    maximumOutputBytes: Math.min(bound.binding.bounds.maximumOutputBytes, invocation.maximumOutputBytes),
  };
}

/** Run one family, projecting its closed refusals onto fixed problem codes. */
async function runFamily(
  bound: BoundPhaseV1, action: CompiledPackActionV1,
  invocation: HostHandlerInvocationV1, deps: PackHostRuntimeDepsV1,
): Promise<FamilyOutcomeV1> {
  const evidence = await evidenceFor(bound, action, deps);
  if (evidence.kind !== "evidence") return evidence;
  try {
    return await computeFamily(bound.binding, evidence.evidence, boundsFor(bound, invocation), deps, action);
  } catch (cause) {
    if (cause instanceof PackDeferredError) return refused(PROBLEM.familyDeferred, cause.message);
    if (cause instanceof PackHostHandlerError) return refused(PROBLEM.familyRefused, cause.message);
    throw cause;
  }
}

/** The host-owned scratch directory this registry writes family output into. */
interface ScratchV1 { dir: Promise<string> | null }

/** Create the run's scratch directory once, on the first execution that needs it. */
function scratchDir(scratch: ScratchV1): Promise<string> {
  scratch.dir ??= mkdtemp(path.join(os.tmpdir(), "llmwiki-pack-host-"));
  return scratch.dir;
}

/**
 * Serialize one family result to host-owned scratch and describe it as output
 * evidence. The file is named by phase instance, so a retried attempt REPLACES
 * its predecessor's bytes rather than accumulating a file per attempt. Nothing
 * authoritative is written: `admitHostHandlerLeg` recustodies this path and the
 * attempt commit publishes it under the project lock.
 */
async function publishOutput(
  scratch: ScratchV1, invocation: HostHandlerInvocationV1, bound: BoundPhaseV1, result: unknown,
): Promise<HostHandlerResultV1> {
  const bytes = canonicalBytes(result);
  const digest = parseSha256Digest(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  let sourcePath: string;
  try {
    sourcePath = path.join(await scratchDir(scratch), `${invocation.phaseInstanceId}.json`);
    await writeFile(sourcePath, bytes, { mode: 0o600 });
  } catch {
    return failure(PROBLEM.outputUnwritable, "host handler output could not be written to scratch custody");
  }
  return {
    kind: "completed", succeededWithWarnings: false, outputEvidenceDigest: digest,
    outputs: [{
      sourcePath, mediaType: OUTPUT_MEDIA_TYPE,
      provenanceLabel: `pack-${bound.binding.family}-output`,
      digest, byteCount: bytes.byteLength,
    }],
  };
}

/**
 * Build the EXECUTABLE per-run host-handler registry for one compiled action.
 *
 * @param action - The compiled action whose phase bindings carry the real closed
 *   recipe bodies, per-phase bounds, and sealed initial input.
 * @param deps - The run-scoped manifest digest, run id, principal, and clock.
 * @returns A registry whose `resolve` binds 3A's registered descriptor and whose
 *   handler actually computes the bound phase's family.
 */
export function createPackHostHandlerRegistry(
  action: CompiledPackActionV1, deps: PackHostRuntimeDepsV1,
): PreparationHostHandlerRegistryV1 {
  const bindings = indexByPhaseInstance(action, deps.manifestDigest);
  const scratch: ScratchV1 = { dir: null };
  // The 3A resolver is the ONE home of the unknown-id / version-drift /
  // digest-drift refusals; only the pending-runtime handler is replaced here.
  const descriptorFor = createHostHandlerRegistry().resolve;
  const handler = {
    async execute(invocation: HostHandlerInvocationV1): Promise<HostHandlerResultV1> {
      const bound = bindings.get(invocation.phaseInstanceId);
      if (bound === undefined) {
        return failure(PROBLEM.unknownPhase, "no compiled phase binding for this phase instance");
      }
      const outcome = await runFamily(bound, action, invocation, deps);
      return outcome.kind === "refused"
        ? failure(outcome.problem, outcome.detail)
        : publishOutput(scratch, invocation, bound, outcome.result);
    },
  };
  return {
    resolve: (ref: HostHandlerRefV1): HostHandlerResolutionV1 => ({
      descriptor: descriptorFor(ref).descriptor, handler,
    }),
  };
}

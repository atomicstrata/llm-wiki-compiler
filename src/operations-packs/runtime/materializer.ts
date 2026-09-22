/**
 * @file src/operations-packs/runtime/materializer.ts
 * @description The contract-bound materializer for a compiled pack action
 * (runner design v3 §5). The runner calls it exactly once, while the run is still
 * `running`, with the durable run and the BYTES it read back out of the
 * preparation evidence store; this module turns the terminal intent phase's
 * published drafts into ONE Milestone A obligation candidate.
 *
 * IT DERIVES THE OBLIGATION FROM DURABLE STATE. The producing phase is named by
 * the compiled materialization spec, its output evidence digest and its producing
 * attempt are read off the durable phase summary, and the bytes come from the
 * runner's verified read-back map — never from anything the compiler or the
 * caller still holds in memory. If that evidence is absent, unparseable, or is
 * not the intent family's own result shape, this THROWS: a materializer that
 * invents an obligation when the run produced none is the exact failure this
 * program exists to prevent, and the runner projects the throw as a typed
 * `refused` rather than a bundle. The ONE non-durable input is the sealed action
 * input behind completeness `planned` for an UNCHAINED terminal, which lives on
 * the preparation manifest rather than in the run-evidence map —
 * {@link expectedIdentities} says exactly what is checked in its place. A CHAINED
 * terminal's `planned` needs no such exception: its predecessor's output IS in
 * the run-evidence map.
 *
 * IT EMITS A REAL MUTATION. Every surviving draft becomes one Milestone A create
 * TARGET, one PROPOSAL, and one accept RECONCILIATION — see
 * {@link authorPackObligation} for the single declared mutation-kind row, why
 * the other four pack intent kinds are refused by name rather than faked, and
 * why the postcondition is the payload's own content address rather than a
 * post-apply observation. The bundle this produces carries a reviewable mutation
 * proposal; APPLYING it remains a separate operation.
 *
 * ZERO DRAFTS IS A REFUSAL, NOT AN EMPTY OBLIGATION. A terminal intent phase
 * that declared no drafts produced nothing to hand off, and a "successful"
 * handoff over an empty draft set is indistinguishable from a working one — that
 * is precisely the mutation an earlier reviewer landed with every suite still
 * green.
 *
 * COMPLETENESS IS DERIVED INDEPENDENTLY OF THE SURVIVORS. `planned` comes from
 * the terminal phase's own INPUT — the sealed action input's decoded item
 * identities when it binds `initial-input`, or the item identities its bound
 * predecessor PUBLISHED when it binds `phase-output` — through the same decoder
 * the executing phase reads that evidence with; `completed` comes from the
 * drafts. A `planned` set taken from the drafts could never show a deficit, so a
 * handler that dropped items — or produced none — would report as complete.
 * Deriving the two sides from different authorities is what gives the deficit
 * teeth: finalization refuses a required deficit outright.
 */

import { createHash } from "node:crypto";
import { DEFAULT_OPERATION_CONTROL_TRANSITION_ALLOWANCE } from "../../operation-bundles/constants.js";
import { deriveCompleteness } from "../../preparations/completeness.js";
import { NoObligationError } from "../../preparations/materialization.js";
import type { PreparationMaterializerV1 } from "../../preparations/runner.js";
import type { PhaseSummaryV1, PreparationRunV1 } from "../../preparations/run-types.js";
import type { AttemptId } from "../../preparations/ids.js";
import type { PhaseExecutorV1 } from "../../preparations/plan-types.js";
import type { EvidenceRefV1 } from "../../preparations/types.js";
import type { CompiledPackActionV1 } from "../compiler-types.js";
import type { PackIntentDraftV1 } from "../handlers/types.js";
import { PackMaterializationError } from "../problems.js";
import { actionInputItemIdentities, predecessorOutputItemRecords } from "./host-registry.js";
import { authorPackObligation, type PackObligationV1 } from "./materializer-obligation.js";
import { packPolicyContractFor } from "./policy-contract.js";

export { PackMaterializationError } from "../problems.js";

const SHA256_PREFIX = "sha256:";

/** The completeness scope one compiled pack action's obligation is derived under. */
const PACK_COMPLETENESS_SCOPE = "pack-action";

/** The bounds the obligation declares, named for the spec fields they come from. */
const PAYLOAD_REF_BOUND = "materialization-payload-refs";
const PAYLOAD_BYTE_BOUND = "materialization-payload-bytes";

/** The terminal phase's published output: its ref, bytes, and producing attempt. */
interface TerminalOutputV1 {
  readonly ref: EvidenceRefV1;
  readonly bytes: Buffer;
  readonly attemptId: AttemptId;
}

/** The bare CAS key of one prefixed evidence digest. */
function bareDigest(digest: string): string {
  return digest.startsWith(SHA256_PREFIX) ? digest.slice(SHA256_PREFIX.length) : digest;
}

/** The phase states whose published output evidence a handoff may be derived from. */
const SUCCEEDED_STATES: ReadonlySet<string> = new Set(["succeeded", "succeeded-with-warnings"]);

/**
 * Locate the terminal intent phase's published output. The digest and the
 * producing attempt come from the durable phase summary, the reference from the
 * run's own recorded evidence, and the bytes from the runner's verified
 * read-back — durable sources that must agree, or there is no obligation to
 * materialize.
 */
function terminalOutput(
  action: CompiledPackActionV1, run: PreparationRunV1, evidence: ReadonlyMap<string, Buffer>,
): TerminalOutputV1 {
  const producing = action.materializationSpec.producingPhaseId;
  const summary: PhaseSummaryV1 | undefined = run.phaseSummaries.find((entry) =>
    entry.logicalPhaseId === producing && SUCCEEDED_STATES.has(entry.state));
  if (summary?.outputEvidenceDigest === undefined) {
    throw new PackMaterializationError(`phase ${producing} published no output evidence`);
  }
  const bare = bareDigest(summary.outputEvidenceDigest);
  const bytes = evidence.get(bare);
  const ref = run.evidenceRefs.find((entry) => bareDigest(entry.digest) === bare);
  if (bytes === undefined || ref === undefined) {
    throw new PackMaterializationError(`phase ${producing} output evidence is not durable`);
  }
  if (summary.currentAttemptId === undefined) {
    throw new PackMaterializationError(`phase ${producing} records no producing attempt`);
  }
  return { ref, bytes, attemptId: summary.currentAttemptId };
}

/**
 * Read the intent family's own drafts out of the durable bytes. Anything else —
 * a different family's result, truncated bytes, a `drafts` member that is not a
 * list of complete drafts — is a refusal, never a coerced empty set. A terminal
 * phase that declared ZERO drafts is refused for the same reason: an obligation
 * over nothing is not an obligation.
 */
function intentDrafts(output: TerminalOutputV1): readonly PackIntentDraftV1[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.bytes.toString("utf8"));
  } catch {
    throw new PackMaterializationError("terminal output evidence is not valid JSON");
  }
  const drafts = (parsed as { drafts?: unknown } | null)?.drafts;
  if (!Array.isArray(drafts)) {
    throw new PackMaterializationError("terminal output evidence declares no intent drafts");
  }
  if (drafts.length === 0) {
    // NOT a PackMaterializationError: nothing was wrong, there was simply
    // nothing left to propose. See NoObligationError for why it is a type.
    throw new NoObligationError("the terminal phase proposed nothing: the store already holds every item");
  }
  return drafts.map(capturedDraft);
}

/** The four non-empty string members every published intent draft carries. */
const DRAFT_TEXT_KEYS = Object.freeze([
  "sourceItemId", "mutationKind", "targetProfileClass", "payloadDigest",
] as const);

/** True when `value` is a plain data record rather than null or a list. */
function isDataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when every required draft member is present as a non-empty string. */
function hasDraftText(record: Readonly<Record<string, unknown>>): boolean {
  return DRAFT_TEXT_KEYS.every((key) => {
    const value = record[key];
    return typeof value === "string" && value.length > 0;
  });
}

/** Validate one durable draft record's own shape before anything reads it. */
function capturedDraft(value: unknown): PackIntentDraftV1 {
  if (!isDataRecord(value) || !isDataRecord(value.fields) || !hasDraftText(value)) {
    throw new PackMaterializationError("an intent draft is not a complete draft record");
  }
  return value as unknown as PackIntentDraftV1;
}

/**
 * The item identities the terminal phase's bound INPUT decodes to — the set a
 * correct handler is expected to produce a draft for.
 *
 * IT WALKS EVERY BINDING WITH THE EXECUTOR'S OWN UNION RULE. The runtime's
 * `evidenceFor` gives an executing phase the union of its bound sources — the
 * sealed action input when `initial-input` is bound, plus EVERY bound
 * predecessor's published items — so `planned` must be that same union, decoded
 * through the same decoders. Reading only one binding here diverged from
 * execution: a terminal bound to the action input plus an empty predecessor
 * legitimately drafts from the action input alone, and deriving `planned` from
 * the one empty predecessor refused a correct run. An EMPTY predecessor list is
 * a valid zero contribution; only an empty TOTAL union is refused. Duplicate
 * identities collapse: `planned` is a set, and the same identity arriving from
 * two sources is one expected item.
 *
 * The action input is the ONE non-durable member of that union, because it is
 * recorded on the preparation MANIFEST and never enters the run-evidence map;
 * its bytes are re-hashed against the digest the plan itself declares before
 * they are decoded. Predecessor items come from the runner's verified read-back.
 */
function expectedIdentities(
  action: CompiledPackActionV1, run: PreparationRunV1, evidence: ReadonlyMap<string, Buffer>,
): ExpectedIdentitySetsV1 {
  const producing = action.materializationSpec.producingPhaseId;
  const terminal = action.plan.phases.find((phase) => phase.logicalPhaseId === producing);
  const union = new Set<string>();
  const dispositioned = new Set<string>();
  for (const binding of terminal?.inputBindings ?? []) {
    const records = binding.sourceKind === "phase-output"
      ? expectedFromPredecessor(run, evidence, binding.sourcePhaseId,
          action.plan.phases.find((phase) => phase.logicalPhaseId === binding.sourcePhaseId)?.executor)
      : sealedActionInputIdentities(action).map((itemId) => ({ itemId, dispositioned: false }));
    for (const record of records) {
      union.add(record.itemId);
      if (record.dispositioned) dispositioned.add(record.itemId);
      // An identity arriving BOTH dispositioned and not (two predecessors) is
      // expected work: one source still asked for it.
      else dispositioned.delete(record.itemId);
    }
  }
  if (union.size === 0) {
    throw new PackMaterializationError("the terminal phase's bound inputs decode to no evidence item identity");
  }
  return { expected: [...union], dispositioned };
}

/** The terminal's bound union, plus the identities a comparison dispositioned. */
interface ExpectedIdentitySetsV1 {
  readonly expected: readonly string[];
  readonly dispositioned: ReadonlySet<string>;
}

/** The sealed action input's item identities, verified against the plan's digest. */
function sealedActionInputIdentities(action: CompiledPackActionV1): readonly string[] {
  const bytes = action.initialInput.bytes;
  const sealed = action.plan.initialInputSet;
  if (createHash("sha256").update(bytes).digest("hex") !== bareDigest(sealed.digest)) {
    throw new PackMaterializationError("the compiled action input does not hash to the plan's sealed input set");
  }
  const identities = actionInputItemIdentities(bytes);
  if (identities === null) {
    throw new PackMaterializationError("the sealed action input decodes to no evidence item identity");
  }
  return identities;
}

/**
 * One bound predecessor's contribution to the expected identity set: the item
 * identities it PUBLISHED, decoded through the same rule the executing phase
 * read them with. This keeps completeness `planned` derived from the terminal
 * phase's actual INPUT (a durable read-back) rather than from the drafts, so a
 * dropped item still shows a required deficit. The predecessor summary is found
 * by logical phase id, exactly as {@link terminalOutput} finds the producing
 * phase. An empty published list returns empty — the union caller decides
 * whether the TOTAL is refusable — but an absent or undecodable output is still
 * a refusal, never a silent zero.
 */
function expectedFromPredecessor(
  run: PreparationRunV1, evidence: ReadonlyMap<string, Buffer>, sourcePhaseId: string | undefined,
  executor: PhaseExecutorV1 | undefined,
): readonly import("./host-registry.js").PredecessorItemRecordV1[] {
  if (sourcePhaseId === undefined) throw new PackMaterializationError("the terminal phase-output binding names no source phase");
  const summary = run.phaseSummaries.find((entry) =>
    entry.logicalPhaseId === sourcePhaseId && SUCCEEDED_STATES.has(entry.state));
  if (summary?.outputEvidenceDigest === undefined) {
    throw new PackMaterializationError(`predecessor phase ${sourcePhaseId} published no output evidence`);
  }
  const bytes = evidence.get(bareDigest(summary.outputEvidenceDigest));
  if (bytes === undefined) throw new PackMaterializationError(`predecessor phase ${sourcePhaseId} output evidence is not durable`);
  const records = predecessorOutputItemRecords(bytes, executor);
  if (records === null) {
    throw new PackMaterializationError(`predecessor phase ${sourcePhaseId} output decodes to no evidence item list`);
  }
  return records;
}

/**
 * Refuse a draft naming an item identity the sealed action input never declared.
 * The identity-set equations would refuse it too (`completed ⊄ attempted`), but
 * as an unnamed containment failure; naming it here says what actually went
 * wrong — a handler produced work for something the run was not sealed over.
 */
function assertCompletedWithinExpected(expected: readonly string[], completed: readonly string[]): void {
  const declared = new Set(expected);
  if (completed.some((identity) => !declared.has(identity))) {
    throw new PackMaterializationError("an intent draft names an item identity the sealed action input never declared");
  }
}

/**
 * Derive completeness from two INDEPENDENT authorities: `planned` from the
 * sealed input's expected identities, `completed` from the drafts that survived.
 * An expected identity with no draft lands in `unavailable` — the outcome
 * categories must exactly cover `eligible` — and becomes a REQUIRED deficit,
 * which `assertCompletenessPermitsSuccess` refuses at finalization. A draft
 * naming an identity the input never declared fails the containment equation
 * instead of silently enlarging the obligation.
 */
function completenessFor(
  action: CompiledPackActionV1, output: TerminalOutputV1,
  sets: ExpectedIdentitySetsV1, completed: readonly string[],
): unknown {
  const { expected, dispositioned } = sets;
  // Containment runs over the FULL union: a draft may legitimately name a
  // dispositioned identity (an operator's gate revision overrides a finding),
  // and refusing it would make review revisions unmaterializable.
  assertCompletedWithinExpected(expected, completed);
  const produced = new Set(completed);
  // An UNDRAFTED identity the comparison DISPOSITIONED is deduplication
  // working — the store holds it, and the plan's own comparison said so — so it
  // is not planned terminal work. Leaving it in `planned` made every
  // partially-novel ingest refuse with a required deficit. A drafted
  // dispositioned identity stays planned (it was produced); an undrafted one
  // nothing dispositioned stays a required deficit finalization refuses.
  const planned = expected.filter((identity) => produced.has(identity) || !dispositioned.has(identity));
  return deriveCompleteness({
    scopeId: PACK_COMPLETENESS_SCOPE,
    classes: [{
      classId: action.materializationSpec.outputEvidenceClass,
      disposition: "required", identitySetRef: output.ref,
      identitySets: {
        planned, eligible: planned, attempted: planned,
        completed, included: completed,
        unavailable: planned.filter((identity) => !produced.has(identity)),
        skipped: [], failed: [], cancelled: [], overflow: [], nonConverged: [],
      },
    }],
  }).record;
}

/**
 * The frozen initial input set, recorded as the obligation's ONE authority input.
 *
 * `selected` is true and its rationale is the COMPILED PLAN DIGEST, because the
 * plan document is the host record that chose this exact input: it
 * content-addresses the set in `initialInputSet`, and the digest is recomputable
 * from the durable manifest, so the selection is auditable rather than asserted.
 */
function authorityInputs(action: CompiledPackActionV1): readonly Readonly<Record<string, unknown>>[] {
  const input = action.plan.initialInputSet;
  return [{
    id: bareDigest(input.digest), provenance: input.provenanceLabel, digest: input.digest,
    byteCount: input.byteCount, selected: true, rationaleDigest: action.planDigest,
  }];
}

/** The obligation's declared bounds, copied from the compiled materialization spec. */
function authorityBounds(action: CompiledPackActionV1): readonly Readonly<Record<string, unknown>>[] {
  const spec = action.materializationSpec;
  return [
    { name: PAYLOAD_REF_BOUND, unit: "count", maximum: spec.maximumPayloadRefs },
    { name: PAYLOAD_BYTE_BOUND, unit: "bytes", maximum: spec.maximumPayloadBytes },
  ];
}

/** Author the obligation's mutation triple from the terminal phase's own drafts. */
function obligationFrom(action: CompiledPackActionV1, output: TerminalOutputV1): PackObligationV1 {
  return authorPackObligation({
    contract: packPolicyContractFor(action), drafts: intentDrafts(output),
    evidenceRef: output.ref, attemptId: output.attemptId,
    producerContractDigest: action.materializationSpec.handlerContractDigest,
  });
}

/** One recorded deficit as a phase publishes it: class, reason, and count. */
interface RecordedDeficitV1 {
  readonly completenessClass: string;
  readonly reason: string;
  readonly droppedCount: number;
}

/**
 * The deficits one phase's published output records, or none for bytes that
 * are not a deficit-bearing envelope. Only host-handler families publish the
 * JSON envelope that can carry `deficits`; an output shape that is not JSON
 * structurally cannot record one, so such bytes are deficit-free rather than
 * refused.
 */
function recordedDeficits(bytes: Buffer): readonly RecordedDeficitV1[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return [];
  }
  const deficits = (parsed as { deficits?: unknown } | null)?.deficits;
  if (!Array.isArray(deficits)) return [];
  return deficits.filter((entry): entry is RecordedDeficitV1 & Record<string, unknown> =>
    isDataRecord(entry)
    && typeof entry.completenessClass === "string"
    && typeof entry.reason === "string"
    && typeof entry.droppedCount === "number");
}

/**
 * Refuse handoff when any phase recorded a deficit under a required-complete
 * class. The identity-set completeness below only sees rows that SURVIVED into
 * a published item list — a row a validating select dropped is absent from
 * every set, so its deficit lives solely in that phase's own output and would
 * otherwise vanish here: the exact silent drop the class was declared
 * `required-complete` to prevent.
 */
function assertNoRequiredDeficits(
  action: CompiledPackActionV1, run: PreparationRunV1, evidence: ReadonlyMap<string, Buffer>,
): void {
  const required = new Set(action.materializationSpec.requiredCompletenessClasses);
  if (required.size === 0) return;
  for (const summary of run.phaseSummaries) {
    if (!SUCCEEDED_STATES.has(summary.state) || summary.outputEvidenceDigest === undefined) continue;
    const bytes = evidence.get(bareDigest(summary.outputEvidenceDigest));
    // An output the runner cannot read back could be hiding a required
    // deficit, so an absent byte is a refusal, never a pass.
    if (bytes === undefined) {
      throw new PackMaterializationError(`phase ${summary.logicalPhaseId} output evidence is not durable`);
    }
    const offending = recordedDeficits(bytes).find((deficit) => required.has(deficit.completenessClass));
    if (offending !== undefined) {
      throw new PackMaterializationError(
        `phase ${summary.logicalPhaseId} recorded a ${offending.reason} deficit of `
        + `${offending.droppedCount} in required completeness class ${offending.completenessClass}`);
    }
  }
}

/** Assemble the complete obligation candidate from the durable terminal output. */
function candidateFor(
  action: CompiledPackActionV1, run: PreparationRunV1, evidence: ReadonlyMap<string, Buffer>,
): { readonly result: unknown; readonly payloads: ReadonlyMap<string, Buffer> } {
  assertNoRequiredDeficits(action, run, evidence);
  const output = terminalOutput(action, run, evidence);
  const obligation = obligationFrom(action, output);
  return {
    result: {
      targets: obligation.targets, proposals: obligation.proposals,
      reconciliations: obligation.reconciliations, selections: [],
      completeness: completenessFor(action, output, expectedIdentities(action, run, evidence), obligation.completedIdentities),
      authorityInputs: authorityInputs(action), authorityBounds: authorityBounds(action),
      // Nothing is compensable: the pack runtime applies no external effect while
      // preparing, so it declares no compensators.
      //
      // THE ALLOWANCE IS THE PROPOSED OPERATION RUN'S, NOT THE PREPARATION'S, and
      // reading it as the preparation's is how it came to be `1`. That number was
      // justified as "exactly one control transition — the bundle's own genesis",
      // but genesis is an ORDINARY transition and the budget it caps is the whole
      // future life of the run this bundle becomes: its terminal `succeeded`, a
      // `recovery-required` park, a `recovery-resumed`, a compensation. At `1` the
      // executor could not even reach `applying` — that state alone reserves two
      // control slots so a run can always park and then retire honestly — so
      // `apply-started` threw `consumed reserved control transition headroom` and
      // the bundle was UNAPPLYABLE by any surface, including `operation resume`.
      // Nothing caught it because nothing had ever applied one.
      //
      // So it takes the operation layer's own default, imported rather than re-typed
      // and OWNED THERE rather than here: a bundle a product proposed is not a
      // special kind of bundle, and its recovery headroom must not be smaller than
      // any other bundle's. Taking the number from the preparation service instead
      // would have pulled that service into the pack runtime's import reach, which
      // the preparation-service boundary guard refuses — correctly, since this is
      // an operation run's budget and not a preparation's.
      operationRun: {
        declaredCompensatorIndexes: [],
        controlTransitionAllowance: DEFAULT_OPERATION_CONTROL_TRANSITION_ALLOWANCE,
      },
      payloadRefs: obligation.payloadRefs,
    },
    payloads: obligation.payloads,
  };
}

/**
 * Build the contract-bound materializer for one compiled pack action.
 *
 * @param action - The compiled action whose materialization spec names the
 *   producing phase, the output evidence class, and the plan-pinned contract.
 * @returns A materializer whose declared contract digest equals the plan pin, so
 *   the runner admits it, and whose obligation is derived from durable evidence.
 */
export function createPackMaterializer(action: CompiledPackActionV1): PreparationMaterializerV1 {
  return {
    handlerContractDigest: action.materializationSpec.handlerContractDigest,
    materialize: ({ run, evidence }) => candidateFor(action, run, evidence),
  };
}

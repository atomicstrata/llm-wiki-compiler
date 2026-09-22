/**
 * @file src/preparations/service-stage.ts
 * @description The `stage` operation — turn an operator's plan document into a
 * durable preparation run. Design v10 §5 row 4, renamed from `start` by R-2
 * because the operation stages a plan into `planned` and starts no execution.
 *
 * THE SURFACE SUPPLIES THE DOCUMENTS, THE SERVICE DECIDES WHEN THEY ARE NEEDED.
 * The plan and seed arrive as lazily-read text rather than paths or parsed
 * objects, and both halves of that are load-bearing:
 *
 *  - TEXT, not objects. `parseBoundedUniqueJson` rejects duplicate keys and
 *    bounds size and depth; a surface that handed over an already-parsed value
 *    would silently get different acceptance semantics than the CLI, which is
 *    exactly the cross-surface drift the one-service design exists to prevent.
 *  - LAZY, not eager. The project preflight — store present, configuration
 *    readable — is settled before any document is read, and the shipped CLI
 *    refusals depend on that ordering: a bad plan in a project with no store
 *    must report the missing store, not the bad plan. A surface that read its
 *    files first would invert it.
 *
 * THE REQUEST IS CONSTRUCTED FIELD BY FIELD, never spread from caller input.
 * `StagePreparationRequest` carries `dryRun`, `clock`, `idsForTest`,
 * `faultsForTest` and `capacityOptionsForTest`; a caller that could reach any of
 * them could fix the run's identity, freeze its clock, or inject a fault. The
 * caller supplies exactly one thing — the plan document — and the service
 * supplies everything else.
 */

import { RecoveryGateError, acquireMutationLock } from "../operation-bundles/lock-gate.js";
import { releaseLock } from "../utils/lock.js";
import { parseBoundedUniqueJson } from "../profile/templates/signing/json.js";
import { StageCapacityError } from "./capacity.js";
import { MAX_PLAN_BYTES, MAX_PLAN_JSON_DEPTH } from "./constants.js";
import { parsePreparationPlan } from "./plan-parse.js";
import type { NormalizedPreparationPlanV1 } from "./plan-types.js";
import { PREPARATION_VALIDATION_PROBLEMS } from "./problems.js";
import { preparationRunActor } from "./principals.js";
import type { PreparationPrincipal, PreparationSurface } from "./principals.js";
import type { PreparationPrincipalV1 } from "./run-types.js";
import { RunBudgetError } from "./run-budget.js";
import { preparationPreflightRefusal } from "./service-readiness.js";
import { previewPreparation } from "./preview.js";
import { REQUEST_CAPTURE_REFUSAL, capturedRequest } from "./service-request-capture.js";
import { stagePreparationLocked } from "./stage.js";
import type { StagePreparationRequest, StagePreparationResult } from "./stage.js";

/** One operator document as the calling surface was able to produce it. */
export type PreparationDocumentV1 =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The two documents `stage` needs, read on demand.
 *
 * The CLI binds these to operator-named files; the SDK binds them to strings its
 * embedder already holds. Neither shape leaks into the other, and the service
 * reaches no filesystem path a caller chose.
 */
export interface PreparationStageDocumentsV1 {
  /** The operator's plan document. */
  plan(): Promise<PreparationDocumentV1>;
  /** The bytes the plan's declared initial input set hashes to. */
  seed(): Promise<PreparationDocumentV1>;
}

/** Request for the `stage` operation. Carries no actor, surface or grant. */
export interface StageRequestV1 {
  readonly documents: PreparationStageDocumentsV1;
  /** The control-transition budget this run is allowed. */
  readonly controlTransitionAllowance: number;
}

/** The closed outcome of one stage attempt. */
export type StageResultV1 =
  | { readonly status: "staged"; readonly runId: string; readonly workspaceId: string }
  | { readonly status: "refused"; readonly reason: string };

/**
 * Request for the `preview` operation — DELIBERATELY the same shape as
 * {@link StageRequestV1}, and named separately because §5 row 1 names it.
 *
 * Previewing anything other than exactly what `stage` consumes would not be a
 * preview of it. The alias records that the sameness is the contract rather than
 * an accident of implementation, and it gives the operation a name to change
 * independently if the two ever genuinely diverge.
 */
export type PreviewRequestV1 = StageRequestV1;

/**
 * The closed outcome of one preview (§5 row 1).
 *
 * IT CARRIES NO RUN ID, and that is the whole reason it is a separate type. The
 * substrate answers `staged` on its dry-run path — it reports what staging WOULD
 * have produced — and the identity in that answer belongs to a run that was
 * never created. Handing it back put an id that looks like a handle into an
 * operator's `--json` envelope and into an embedder's return value, where the
 * next verb they passed it to could only fail. `workspaceId` survives because it
 * came from the caller's own plan and names something that exists.
 */
export type PreviewResultV1 =
  | { readonly status: "previewed"; readonly workspaceId: string }
  | { readonly status: "refused"; readonly reason: string };

/**
 * The substrate classes whose throws mean "this cannot proceed", not "this
 * broke partway".
 *
 * Every one is raised BEFORE any durable publication: plan and identity
 * validation, declared bounds, workspace capacity, and the run-budget
 * projection. Anything else — an `ENOSPC` between the evidence write and the
 * manifest write, say — is a fault and stays visible.
 *
 * DERIVED from the validation problems rather than restating them. The manifest
 * loader retypes its rejections into that same list, and two hand-written copies
 * of one enumeration is how a retype and the allowlist that must honour it drift
 * apart. Exported so a test can assert the membership instead of inferring it.
 */
export const STAGE_REFUSALS = [
  ...PREPARATION_VALIDATION_PROBLEMS, StageCapacityError, RunBudgetError,
] as const;

/** Why this plan cannot be staged at all. */
function planRefusal(plan: NormalizedPreparationPlanV1): string | null {
  // An `ephemeral-read` plan is BY DESIGN never durably stored, and nothing in
  // the genesis path consulted `executionMode` — so one staged exit 0 and
  // appeared in `list` as a durable run.
  return plan.executionMode === "ephemeral-read"
    ? "an ephemeral-read plan is never durably staged"
    : null;
}

/** Normalize the document, then ask whether this plan may be staged at all. */
function normalizePlan(text: string) {
  let plan: NormalizedPreparationPlanV1;
  try {
    plan = parsePreparationPlan(text);
  } catch (error) {
    // The parser's message names the offending field and carries no host path,
    // so it is safe to surface and is what an operator needs to fix the file.
    return { ok: false as const, reason: `plan is invalid: ${error instanceof Error ? error.message : "unparseable"}` };
  }
  const unstageable = planRefusal(plan);
  return unstageable === null
    ? { ok: true as const, plan }
    : { ok: false as const, reason: unstageable };
}

/** Read and normalize the caller's plan document. */
async function loadPlan(documents: PreparationStageDocumentsV1) {
  const document = await documents.plan();
  return document.ok ? normalizePlan(document.text) : { ok: false as const, reason: document.reason };
}

/** Parse the seed through the same hardened reader the plan leg uses. */
function parseSeed(text: string) {
  try {
    // THE SAME HARDENED READER THE PLAN LEG USES. Bare `JSON.parse` accepted
    // DUPLICATE KEYS last-wins, so `{"seed":"decoy","seed":"real"}` staged the
    // second value while the plan leg beside it refuses duplicates outright —
    // and the digest cannot catch it, because the digest is over the PARSED
    // value. It also had no depth bound (2000 levels blew the stack) and no
    // size bound before the read.
    return { ok: true as const, value: parseBoundedUniqueJson(text, MAX_PLAN_BYTES, MAX_PLAN_JSON_DEPTH) };
  } catch (error) {
    return {
      ok: false as const,
      reason: `seed is invalid: ${error instanceof Error ? error.message : "unparseable"}`,
    };
  }
}

/**
 * Read the bytes the plan's declared initial input set hashes to.
 *
 * The schema REQUIRES an input set, so this is not optional decoration — a
 * first version refused any plan declaring one, which would have refused every
 * valid plan and left the operation unable to stage anything at all.
 */
async function loadSeed(documents: PreparationStageDocumentsV1) {
  const document = await documents.seed();
  return document.ok ? parseSeed(document.text) : { ok: false as const, reason: document.reason };
}

/**
 * Turn the substrate's typed throws into the declared `refused` arm.
 *
 * A seed whose canonical digest does not match the plan's declared input set is
 * THE everyday operator mistake, and it escaped as
 * "preparation manifest initial evidence omits the plan input set" — an
 * internal validator string naming neither the flag nor the file — straight
 * past the refusal arm, with EMPTY output under `--json`. Three more
 * operator-reachable throws did the same: a dangling supersession target, an
 * allowance that passes validation but exceeds the transition cap, and a
 * degraded inventory.
 *
 * Only errors carrying a message are converted — a fault with none is not a
 * refusal and stays visible.
 */
async function asRefusal(
  run: () => Promise<Awaited<ReturnType<typeof stagePreparationLocked>>>,
): Promise<StageResultV1> {
  let result: Awaited<ReturnType<typeof stagePreparationLocked>>;
  try {
    result = await run();
  } catch (error) {
    // A FAIL-CLOSED ALLOWLIST OF DOMAIN CLASSES, not "any Error". Catching
    // everything converted OPERATIONAL FAULTS into ordinary refusals — and the
    // substrate publishes evidence, then the manifest, then the run, so an I/O
    // failure after the first two reported `refused` while durable state had
    // already changed. A refusal means nothing happened; only errors that
    // genuinely mean that may convert.
    if (!STAGE_REFUSALS.some((klass) => error instanceof klass)) throw error;
    return { status: "refused", reason: `staging refused: ${(error as Error).message}` };
  }
  return result.status === "staged"
    ? { status: "staged", runId: result.manifest.runId, workspaceId: result.manifest.workspaceId }
    : { status: "refused", reason: `staging refused: ${result.reason}` };
}

/** One caller's documents, read and normalized, ready to publish through. */
interface LoadedStageDocumentsV1 {
  readonly plan: NormalizedPreparationPlanV1;
  /** The parsed seed value the plan's declared initial input set hashes to. */
  readonly value: unknown;
  readonly allowance: number;
}

/**
 * The id a preview's projection is attributed to.
 *
 * PREVIEW RESOLVES NO PRINCIPAL, because it charges no grant (§5 row 1), so
 * there is no actor identity to project. Every field this feeds is discarded:
 * the projected manifest's `createdBy` is never published, and the prepared-input
 * identity it contributes to lives only in memory. What DOES matter is the
 * `surface`, which the service supplies from its own construction — it selects
 * the recorded seed provenance, so a preview and the stage it previews must agree
 * on it or they would project different prepared-input identities.
 */
const PREVIEW_ACTOR_ID = "preview";

/** Build the request field by field and publish it through `publish`. */
async function publishStageRequest(
  root: string, documents: LoadedStageDocumentsV1,
  actor: PreparationPrincipalV1, publish: PreparationPublisher,
): Promise<StageResultV1> {
  const { plan, value, allowance } = documents;
  return asRefusal(async () => publish(root, {
    // FIELD BY FIELD. No spread of anything the caller supplied.
    plan, createdBy: actor, actor,
    initialInputs: [{
      kind: "structured",
      source: {
        // DERIVED FROM THE PRINCIPAL'S SURFACE, which keeps the CLI's recorded
        // `cli-seed` byte-identical while stopping a second surface from
        // recording a provenance that names a transport it did not come from.
        // The identity feeds `mintPreparedInputId`, so it is durable.
        value, sourceIdentity: `${actor.surface}-seed`,
        // DERIVED FROM THE PLAN, not hardcoded. The plan's `initialInputSet`
        // already declares the classification, and hardcoding a different one
        // silently DOWNGRADED it: a plan declaring `restricted`/`audit` was
        // persisted as `ordinary`/`until-handoff`, which also changes prune
        // eligibility. Nothing caught it because the coverage check compares
        // the digest only, and the digest is over the value alone — metadata
        // never enters it.
        provenanceLabel: plan.initialInputSet.provenanceLabel,
        mediaType: plan.initialInputSet.mediaType,
        sensitivity: plan.initialInputSet.sensitivity,
        retention: plan.initialInputSet.retention,
        evidenceKind: plan.initialInputSet.kind,
      },
    }],
    controlTransitionAllowance: allowance,
  }));
}

/**
 * The substrate call one request is published through.
 *
 * `stage` publishes durably; `preview` runs the SAME transaction on its forced
 * dry-run path. Parameterising the one call rather than giving preview its own
 * pipeline is what keeps the two agreeing: every leg before this point — the
 * request capture, the plan and seed readers, the refusal mapping — is literally
 * the same code, so they cannot come to disagree about what a plan means or
 * about which failures are refusals.
 *
 * WHAT IS NOT SHARED IS THE ACQUISITION, and it must not be: see
 * {@link previewPreparationOperation}.
 */
type PreparationPublisher = (
  root: string, request: StagePreparationRequest,
) => Promise<StagePreparationResult>;

/** Take the project lock, then publish through `publish`. */
async function stageUnderMutationLock(
  root: string, documents: LoadedStageDocumentsV1,
  actor: PreparationPrincipalV1, publish: PreparationPublisher,
): Promise<StageResultV1> {
  // UNDER THE PROJECT LOCK. `stagePreparationLocked` documents that its caller
  // already holds it, and calling it bare let six concurrent stages race on
  // `resolveKeyEpoch` — the trust root — producing raw EEXIST/ENOENT faults. It
  // also skipped the recovery gate entirely, so a stage could mint durable state
  // while an operation bundle sat mid-apply.
  //
  // NAMED AT THE SEAM THAT RACES, not at the minting helper below it. This
  // comment used to name that helper, and the name changed underneath it — a
  // comment pointing at a private callee goes stale on somebody else's
  // refactor. `resolveKeyEpoch` is where the concurrent stages actually
  // collide, and it is the name that survived the rename.
  // BOTH WAYS THE GATED ACQUISITION DECLINES ARE ANSWERS. `acquireMutationLock`
  // is not a mutex; it refuses at `ordinary` while any lifecycle unit is
  // pending, and that refusal threw — so a `stage` attempted in a project
  // holding an unfinished key reset returned exit 1 with an EMPTY `--json`
  // body. Measured through the binary. Only the busy arm was ever carried,
  // because nothing that shipped could leave a pending reset unit for an
  // operator to meet.
  let acquired: boolean;
  try {
    acquired = await acquireMutationLock(root, "ordinary");
  } catch (error) {
    if (error instanceof RecoveryGateError) return { status: "refused", reason: error.message };
    throw error;
  }
  if (!acquired) return { status: "refused", reason: "project lock is busy" };
  try {
    return await publishStageRequest(root, documents, actor, publish);
  } finally {
    await releaseLock(root);
  }
}

/** One stage request, copied out of the caller's object field by field. */
interface CapturedStageRequestV1 {
  readonly documents: PreparationStageDocumentsV1;
  readonly controlTransitionAllowance: number;
}

/**
 * Capture the request in the operation's SYNCHRONOUS PROLOGUE (D-10-9).
 *
 * The request used to be read after the preflight `await`, so a caller could
 * retarget its documents or its allowance while the operation was in flight and
 * the retargeted values were what got staged. Every surface inherited that,
 * which is why the capture lives here rather than only in the SDK facade: this
 * is the seam a second host constructs.
 *
 * CAPTURING A CALLABLE IS NOT INVOKING IT. The readers are bound to their owning
 * object and stored; nothing is read until the service decides to read it, which
 * is what preserves the deliberate ordering — project preflight first, documents
 * only after it passes. Binding is the point: it fixes both the function and its
 * receiver, so reassigning `documents.plan` afterwards moves nothing.
 *
 * THE OUTER REQUEST IS READ BY DESCRIPTOR AND THE DOCUMENT MEMBERS ARE NOT, and
 * the asymmetry is deliberate. `documents.plan`/`.seed` are DECLARED AS METHODS,
 * so a class-based provider is a legitimate caller shape and refusing an
 * accessor there would be a contract change wearing hardening's clothes. The
 * property that matters for them is not non-execution — the service invokes them
 * by design — but that each is read EXACTLY ONCE and bound, so a second read
 * cannot yield a second function. `documents` and `controlTransitionAllowance`
 * carry no such contract and are plain own data.
 */
function captureStageRequest(request: StageRequestV1): CapturedStageRequestV1 | null {
  const captured = capturedRequest<StageRequestV1>(request);
  if (captured === null) return null;
  const documents = captured.documents;
  const plan = documents.plan.bind(documents);
  const seed = documents.seed.bind(documents);
  return {
    documents: { plan, seed },
    controlTransitionAllowance: captured.controlTransitionAllowance,
  };
}

/**
 * Stage the plan, or say why not.
 *
 * `principal` is already captured and already charged its `preparation.run`
 * grant by the service composition — authority is settled before this function
 * is reachable, so nothing here re-derives it.
 */
export async function stagePreparationOperation(
  root: string, principal: PreparationPrincipal, request: StageRequestV1,
): Promise<StageResultV1> {
  const documents = await loadStageDocuments(root, request);
  if (!documents.ok) return { status: "refused", reason: documents.reason };
  return stageUnderMutationLock(
    root, documents.documents, preparationRunActor(principal), stagePreparationLocked);
}

/**
 * Purely PREVIEW one plan: every check `stage` runs, no project byte written.
 *
 * IT ROUTES THROUGH THE SAME PRIMITIVE rather than reimplementing the checks.
 * `previewPreparation` forces the substrate's own dry-run path, which is why a
 * preview cannot drift from the stage it is previewing: a check added to staging
 * is a check preview inherits, and there is no second copy to forget.
 *
 * IT TAKES NO LOCK (§5 row 1), AND SHARING `stage`'s ACQUISITION MADE IT MUTATE.
 * `acquireMutationLock` is not a mutex; it is the gated acquisition, and the gate
 * behind it recovers the page journal, refuses on bundle recovery, gates the
 * lifecycle and then SETTLES OUTSTANDING PREPARATION HANDOFFS
 * (`lock-gate.ts:557-580`). A run sitting at `handoff-started` therefore became
 * `handed-off` because somebody asked what a plan would do — a durable transition
 * appended by a verb whose entire contract is that it writes nothing. Reproduced
 * on the run's own state, not on a count.
 *
 * NOTHING ON THE DRY-RUN PATH NEEDS THE LOCK, which is why dropping it is a fix
 * rather than a trade. `stagePreparationLocked` returns before `publishStage` on
 * every dry-run branch, and a key epoch minted for an empty project carries its
 * durable write in a deferred `publish` the dry run never calls — so the path
 * performs no write to serialize against. What the lock did buy was a consistent
 * snapshot; losing it can cost a preview a stale answer or a raw read fault under
 * a concurrent stage, and can never cost a byte. Preview accordingly no longer
 * reports `"project lock is busy"`: a refusal disappears, none appears.
 *
 * IT RESOLVES NO PRINCIPAL, because it charges no grant (§5 row 1) and asking a
 * host for one would assert an authority decision this operation does not make —
 * exactly as `list` and `show` do not. The `surface` comes from the service's own
 * construction, never from a caller. What makes grant-free safe is that a caller
 * cannot name a filesystem path here: the documents arrive as TEXT behind readers
 * the calling surface owns. That property is pinned structurally by
 * `preparation-preview-no-caller-path`, which walks this request's type with the
 * compiler and fails on any new member.
 *
 * @param root - The project root this invocation previews within.
 * @param surface - The host's fixed transport surface, copied at construction.
 * @param request - The plan documents and the allowance to project against.
 * @returns What staging WOULD have answered, having written nothing.
 */
export async function previewPreparationOperation(
  root: string, surface: PreparationSurface, request: PreviewRequestV1,
): Promise<PreviewResultV1> {
  const documents = await loadStageDocuments(root, request);
  if (!documents.ok) return { status: "refused", reason: documents.reason };
  const actor = { id: PREVIEW_ACTOR_ID, surface };
  return asPreview(
    await publishStageRequest(root, documents.documents, actor, previewPreparation));
}

/**
 * Project the shared staging answer onto preview's own vocabulary.
 *
 * The projection is deliberately LOSSY in exactly one direction: the substrate's
 * `staged` answer names a run identity nothing created, and preview's contract is
 * that it created nothing. Dropping it here rather than at each surface is what
 * stops one renderer from keeping it.
 */
function asPreview(result: StageResultV1): PreviewResultV1 {
  return result.status === "staged"
    ? { status: "previewed", workspaceId: result.workspaceId }
    : { status: "refused", reason: result.reason };
}

/** The loaded documents, or the refusal that stopped them being loaded. */
type StageDocumentLoadV1 =
  | { readonly ok: true; readonly documents: LoadedStageDocumentsV1 }
  | { readonly ok: false; readonly reason: string };

/**
 * The legs `stage` and `preview` share in full: capture, project preflight, plan,
 * seed. The acquisition and the publisher are each operation's own.
 *
 * The request capture stays in each operation's reach of its OWN synchronous
 * prologue by being the first thing this function does and the operations doing
 * nothing before calling it — no await intervenes, so D-10-9 still holds.
 */
async function loadStageDocuments(
  root: string, request: StageRequestV1,
): Promise<StageDocumentLoadV1> {
  const captured = captureStageRequest(request);
  if (captured === null) return { ok: false, reason: REQUEST_CAPTURE_REFUSAL };
  const blocked = await preparationPreflightRefusal(root);
  if (blocked !== null) return { ok: false, reason: blocked };
  const loaded = await loadPlan(captured.documents);
  if (!loaded.ok) return { ok: false, reason: loaded.reason };
  const seed = await loadSeed(captured.documents);
  if (!seed.ok) return { ok: false, reason: seed.reason };
  return {
    ok: true,
    documents: {
      plan: loaded.plan, value: seed.value,
      allowance: captured.controlTransitionAllowance,
    },
  };
}

/**
 * @file src/preparations/service.ts
 * @description The one preparation service every surface adapts (design v10
 * D-10-1). It exposes EXACTLY FOURTEEN NAMED OPERATIONS — `stage`, `preview`,
 * `list`, `show`, `fail`, `cancel`, `pause`, `resume`, `recovery`, `gate`,
 * `handoff`, `prune`, `sweep`, `reset` — because exactly fourteen operations'
 * worth of behaviour ships today. Each arrived with the
 * surfaces that can carry it in the same change; none of them is a shape waiting
 * for a caller.
 *
 * TWO OF THE FOURTEEN ARE NOT ON EVERY SURFACE, and both asymmetries are
 * recorded rather than smoothed over, because they are opposite in kind.
 *
 * `handoff` has an SDK method and no CLI verb (R-7). Its request carries a
 * host-authored obligation set — compiled proposals, reconciliation decisions,
 * content-addressed payload bytes, an eleven-category completeness record — that
 * has no textual operator representation and no parser in the tree. A CLI verb
 * would have to either invent that document format for a producer that does not
 * exist yet, or be a verb that can only refuse. That restriction is a CAPABILITY
 * gap and is enforced by nothing: a CLI host holding an obligation set could
 * construct this service and call it today. Adding a check would assert a
 * boundary that is not one.
 *
 * `reset` is the mirror — CLI-ONLY — and its restriction IS a boundary, enforced
 * in `service-reset.ts` (D-10-12/D-10-14). This file argued the opposite until
 * the verb shipped, and the argument is kept here because it was right about one
 * thing and silent about a larger one. It ran: reset costs
 * `preparation.quarantine`, the SAME token `prune` and `sweep` legitimately need
 * on the SDK surface, so the moment reset joins this service every SDK host
 * holding the destructive token has a door to the project key that only a
 * surface comparison keeps shut — therefore not adding the operation is a
 * stronger boundary than adding it and guarding it.
 *
 * THAT IS TRUE ABOUT SDK REACHABILITY AND IT WAS NOT THE WHOLE LEDGER. Its cost
 * went unstated: with no operation there was no CLI verb either, so the
 * stranded-key repair had no operator surface AT ALL. `resetPreparationKeyEpochLocked`
 * had no caller outside `src/preparations/`, and the approved operator runbook
 * for a project whose key is gone ends by telling its reader to invoke internal
 * functions from a harness that does not exist. A boundary that is perfect
 * because the room has no door is not a boundary; it is an absent capability
 * described as one. The plan anticipated exactly this — R-8 admitted the
 * argument "stops working the moment reset is added" — so what replaces it is
 * the enforcement the plan always specified, at the one place execution happens,
 * with a mutation test that constructs this service as the SDK does and watches
 * it refuse.
 *
 * WHY IT IS THIS SMALL. The superseded attempt at this task built a
 * thirteen-operation service core, a closed authority model and a lifecycle gate
 * matrix with no production caller anywhere in `src/`; fixtures then supplied
 * whatever shape the code expected, seven run states ended up with no emitter,
 * and nothing failed until a reviewer read it. So this extraction is justified by
 * its SECOND CALLER or it is not justified: the CLI and the SDK facade both go
 * through it, and nothing exists here that neither of them uses. There is
 * deliberately NO generic operation registry — a registry is how `reset` would
 * have become reachable from every surface by default, which is precisely the
 * exposure that must stay a decision. That is no longer hypothetical: reset is
 * here, it is named like the other thirteen, and a host reaches it only by being
 * the CLI.
 *
 * AUTHORITY, and the one rule that makes it real (R-5 / D-10-9):
 *
 *  - The host supplies a `PreparationPrincipalResolverV1` at CONSTRUCTION. A
 *    request DTO carries no actor, no surface and no grant, so self-asserted
 *    authority and a forged `surface: "cli"` are unrepresentable rather than
 *    validated.
 *  - The service's surface is FIXED at construction and copied by value. Every
 *    captured principal's surface must EQUAL it. Without that comparison an SDK
 *    host whose resolver returned `surface: "cli"` would inherit the whole
 *    local-operator grant set, because `effectivePreparationGrants` unions it
 *    into any `cli` principal — the check and the executor would be reading two
 *    different authorities.
 *  - The principal is captured SYNCHRONOUSLY, before the first `await`, via the
 *    existing `capturePreparationPrincipal`. This is the exact defect class Task
 *    9 hit four times: an aliased binding retargeted a deletion, and an aliased
 *    clock stayed mutable through two "captures" that looked correct.
 *
 * HONEST LIMIT, stated because it bounds what a green grant check proves: a
 * `cli` principal effectively holds the whole local-operator set by transport,
 * so the grant check on the CLI path cannot fail and is not evidence of
 * authorization there. It is load-bearing on the `sdk` surface, which holds
 * exactly its explicit grants — and that is what the missing-grant refusal test
 * pins.
 */

import {
  PREPARATION_SURFACES, PrincipalAuthorityError, capturePreparationPrincipal,
  requirePreparationGrant,
} from "./principals.js";
import type { PreparationGrant, PreparationPrincipal, PreparationSurface } from "./principals.js";
import { cancelPreparationOperation } from "./service-cancel.js";
import type { CancelRequestV1, CancelResultV1 } from "./service-cancel.js";
import { failPreparationOperation } from "./service-fail.js";
import type { FailRequestV1, FailResultV1 } from "./service-fail.js";
import { previewPreparationOperation } from "./service-stage.js";
import type { PreviewRequestV1, PreviewResultV1 } from "./service-stage.js";
import { pausePreparationOperation } from "./service-pause.js";
import type { PauseRequestV1, PauseResultV1 } from "./service-pause.js";
import { resumePreparationOperation } from "./service-resume.js";
import type { ResumeRequestV1, ResumeResultV1 } from "./service-resume.js";
import { showPreparationOperation } from "./service-show.js";
import type { ShowRequestV1, ShowResultV1 } from "./service-show.js";
import { gatePreparationOperation } from "./service-gate.js";
import type { GateRequestV1, GateResultV1 } from "./service-gate.js";
import { handoffPreparationOperation } from "./service-handoff.js";
import type { HandoffRequestV1, HandoffResultV1 } from "./service-handoff.js";
import { listPreparationsOperation } from "./service-list.js";
import type { ListResultV1 } from "./service-list.js";
import { prunePreparationOperation } from "./service-prune.js";
import type { PruneRequestV1, PruneResultV1 } from "./service-prune.js";
import { sweepPreparationOperation } from "./service-sweep.js";
import type { SweepResultV1 } from "./service-sweep.js";
import { recoverPreparationOperation } from "./service-recovery.js";
import type { RecoveryRequestV1, RecoveryResultV1 } from "./service-recovery.js";
import { resetPreparationOperation } from "./service-reset.js";
import type { ResetRequestV1, ResetResultV1 } from "./service-reset.js";
import { stagePreparationOperation } from "./service-stage.js";
import type { StageRequestV1, StageResultV1 } from "./service-stage.js";

// The surfaces adapt these types, so the service re-exports them: D-10-1 lets an
// adapter import the service and its exported types, and nothing else from this
// tree. Re-exporting is what makes that boundary satisfiable rather than a rule
// every adapter has to break to compile.
export type { PreparationGrant, PreparationPrincipal, PreparationSurface } from "./principals.js";
export { PrincipalAuthorityError } from "./principals.js";
export { resolveHostReadiness } from "./service-readiness.js";
export type { CancelRequestV1, CancelResultV1 } from "./service-cancel.js";
export type { FailRequestV1, FailResultV1 } from "./service-fail.js";
export type { PauseRequestV1, PauseResultV1 } from "./service-pause.js";
export type { ResumeRequestV1, ResumeResultV1 } from "./service-resume.js";
// THE NESTED SHAPES ARE RE-EXPORTED TOO, and that is the boundary rather than
// convenience. A surface adapter may reach this service and nothing else, so a
// renderer that needs to name one phase or one owner has to be able to name it
// from HERE — importing `service-show.js` for the type is the same violation as
// importing it for the function, and the boundary control catches it as one.
export type {
  ExecutionOwnerReportV1, PhaseReportV1, RunReportV1, ShowRequestV1, ShowResultV1,
} from "./service-show.js";
export type { GateRequestV1, GateResultV1 } from "./service-gate.js";
export { GATE_RECORDABLE_RUN_STATES } from "./service-gate.js";
// A gate decision is one of three closed choices, so a consumer must be able to
// name what it may send.
export type { GateDecision } from "./gates.js";
export type {
  HandoffRequestV1, HandoffResultV1, PreparationHandoffObligationsV1,
} from "./service-handoff.js";
export type { ListResultV1, PreparationRunRowV1 } from "./service-list.js";
export { MAX_PREPARATION_LIST_ITEMS, comparePreparationListing } from "./service-list.js";
export type {
  RecoveryLifecycleV1, RecoveryRequestV1, RecoveryResultV1,
} from "./service-recovery.js";
// Recovery reports it, so a consumer must be able to name what it switches on.
export type { LifecyclePendingUnitV1, PreparationLifecyclePendingState } from "./recovery.js";
// The row state union, so a consumer can name what it switches on.
export type { PreparationRunState } from "./run-types.js";
export type {
  PreparationDocumentV1, PreviewRequestV1, PreviewResultV1, StageRequestV1, StageResultV1,
} from "./service-stage.js";
export type { PruneRequestV1, PruneResultV1 } from "./service-prune.js";
export type { SweepResultV1 } from "./service-sweep.js";
// `ResetContinuationV1` is deliberately NOT re-exported alongside these. The
// nested-shape rule exists so an adapter can NAME what it must construct, and
// the one adapter reset has builds its continuation as an object literal inline
// — so re-exporting the type would add a public name with no consumer rather
// than satisfy the boundary. It becomes re-exportable the day something needs to
// name it.
export type { ResetRequestV1, ResetResultV1 } from "./service-reset.js";
// The two phrases an operator must type. Re-exported because the CLI has to be
// able to TELL them which one — see `service-reset.ts`.
export { FORCED_KEY_CONFIRMATION, MISSING_KEY_CONFIRMATION } from "./service-reset.js";
// The surface refusal is a THROW, so the one surface that can reach reset must
// be able to name the class it would see if it ever stopped being that surface.
export { PreparationSurfaceError } from "./service-reset.js";

/** The closed set of operations this service exposes. Named, never a registry. */
type PreparationOperationV1 =
  "stage" | "preview" | "list" | "show" | "fail" | "cancel" | "pause" | "resume"
  | "recovery" | "gate" | "handoff" | "prune" | "sweep" | "reset";

/**
 * The control-transition budget a run gets when the caller names none.
 *
 * ONE HOME, because two surfaces need it: a per-surface copy is how the CLI and
 * the SDK would come to stage runs with silently different budgets.
 */
export const DEFAULT_CONTROL_TRANSITION_ALLOWANCE = 16;

/**
 * The marker for an operation whose grant is selected by host state the service
 * has not loaded yet, and is therefore charged inside the operation.
 *
 * A distinct value rather than `null`, because `null` already means "grant-free"
 * — collapsing the two would put a gate decision in the same class as the
 * grant-free read, which is exactly the silent default the total table exists to
 * prevent.
 */
const PER_GATE_KIND = "per-gate-kind" as const;

/**
 * The grant each operation costs (D-10-13; no new tokens), TOTAL over the
 * operation set — `null` where the operation is deliberately grant-free.
 *
 * TOTAL IS THE POINT, and the previous shape only looked like it was. It keyed
 * a `Record` by a hand-picked `Extract<…, "stage" | "fail">`, which exerted no
 * completeness pressure at all: adding `reset` to the operation union compiled
 * clean with no grant decision anywhere, and the new operation landed silently
 * in the grant-free class beside `list` — a destructive operation defaulting to
 * needing no authority, against R-4. Keying by the WHOLE union means a new
 * operation does not compile until somebody writes down what it costs, and
 * writing `null` is a decision a reviewer can see.
 */
const OPERATION_GRANT = {
  stage: "preparation.run",
  // GRANT-FREE (§5 row 1), and this entry previously read `preparation.run` on an
  // argument worth stating so nobody re-derives it: preview answers what staging
  // WOULD do, so an embedder who may not stage should not enumerate those answers
  // either. It does not hold, for two measured reasons.
  //
  // THE EXPLOIT IT WAS STANDING IN FOR IS CLOSED BY CONSTRUCTION. In the
  // superseded thirteen-operation line, a grant-free preview took a CALLER-SUPPLIED
  // `sourceRoot` that was also the confinement root, giving an ungranted SDK or MCP
  // client an existence, readability and size oracle over any host path. Here the
  // documents arrive as TEXT behind readers the surface owns, so no caller-named
  // path reaches this service — pinned structurally, and on the request type rather
  // than by inspection, in `preparation-preview-no-caller-path`.
  //
  // AND THE RESIDUAL ENUMERATION ARGUMENT GUARDS LESS THAN THE VERB BESIDE IT.
  // `list` is grant-free and enumerates every run in the project, so an ungranted
  // caller already learns more from it than from any preview answer.
  preview: null,
  list: null,
  // GRANT-FREE for the same reason `list` is (D-10-13): it takes no lock, writes
  // no byte, and reports references rather than the objects behind them, so it
  // discloses nothing a listing does not already.
  show: null,
  fail: "preparation.run",
  cancel: "preparation.cancel",
  // A CONTROL TRANSITION ON THE RUN, so it is the run token rather than the
  // cancel one: pausing asserts nothing about effects and reaches no terminal.
  pause: "preparation.run",
  // THE SAME TOKEN AS `pause`, AND THAT EQUALITY IS THE GUARANTEE. A paused run
  // must be escapable by the least-privileged principal that can pause it, so the
  // exit cannot cost a token the entrance does not. `pause` shipped once with its
  // exits behind `preparation.cancel`, `preparation.recovery` and the destructive
  // `preparation.quarantine`, and an SDK principal holding only `preparation.run`
  // could strand a run permanently. Changing this line to any other token
  // reintroduces that defect.
  //
  // AND THAT IS NOW A CONTROL RATHER THAN THIS SENTENCE. Until the aggregate
  // contract gate shipped, the guarantee lived only in this comment — the same
  // shape of claim whose earlier version failed review, where reachability was
  // traced and authority never was. `preparation-operation-contract` establishes
  // every grant BEHAVIOURALLY and twice: refused holding nothing, accepted
  // holding exactly this token. Mutation-tested by changing this line to
  // `preparation.cancel`; the mutant compiles, and exactly one case goes red
  // naming the operation and the token. Read the control, not this paragraph.
  resume: "preparation.run",
  recovery: "preparation.recovery",
  // NOT A FIXED TOKEN, AND THAT IS A DECISION A REVIEWER CAN SEE. Which grant a
  // gate costs depends on the KIND the run's own plan declares, so it cannot be
  // written down at construction without either picking one of three or letting
  // the caller name the kind. `authorGateProof` charges `GATE_GRANT[gateKind]`
  // against the kind it loaded, which is check and executor at one point; this
  // marker records that the charge happens there rather than here, so the entry
  // is not mistaken for the grant-free class `list` sits in.
  gate: PER_GATE_KIND,
  // Handoff STAGES the bundle; it does not approve or apply it, so it is the run
  // grant and never `operation-bundle.approve`.
  handoff: "preparation.run",
  // THE DESTRUCTIVE PAIR, and they cost the destructive token rather than
  // `preparation.run` (D-10-13). An embedder granted the run token can create
  // and drive preparations; reclaiming their bytes irreversibly is a separate
  // decision a host makes separately.
  prune: "preparation.quarantine",
  sweep: "preparation.quarantine",
  // THE SAME TOKEN AS THE DESTRUCTIVE PAIR, and that equality is the whole
  // reason reset's exposure is enforced rather than assumed. There is no token
  // that would distinguish it here — an SDK host legitimately holds
  // `preparation.quarantine` for `prune` and `sweep` — so the grant table CANNOT
  // be what keeps reset off the SDK, and a reader who expected it to should stop
  // here and read `service-reset.ts`. Minting a fourth destructive token instead
  // was rejected by D-10-13: `PREPARATION_GRANTS` stays closed at eight, and a
  // token invented to express an exposure decision would be an authority model
  // shaped by one surface's menu.
  reset: "preparation.quarantine",
} as const satisfies Record<PreparationOperationV1, PreparationGrant | null | typeof PER_GATE_KIND>;

/**
 * The operations that charge a grant and therefore resolve a principal.
 *
 * DERIVED FROM THE TABLE, not from a second hand-written union — the table is
 * the enumeration, so this is a function of it rather than a list to keep in
 * step. `list` is grant-free by D-10-13 and resolves no principal at all;
 * asking for one would assert an authority decision the read does not make.
 */
export type PreparationGrantedOperationV1 = {
  [K in PreparationOperationV1]: (typeof OPERATION_GRANT)[K] extends null ? never : K;
}[PreparationOperationV1];

/**
 * The host's authority source, and the ONLY one.
 *
 * The host assigns the principal; a caller never presents it. `principalFor` is
 * bound once at construction into a service-owned reference, so reassigning the
 * resolver's method afterwards moves no authority.
 */
export interface PreparationPrincipalResolverV1 {
  /** The COMPLETE host-authenticated principal acting on this call. */
  principalFor(operation: PreparationGrantedOperationV1): PreparationPrincipal;
}

/** What a host must supply to construct the service. */
export interface PreparationServiceDependenciesV1 {
  /** The project root every operation acts within. */
  readonly root: string;
  /** The host's fixed transport surface, copied by value at construction. */
  readonly surface: PreparationSurface;
  /** Host-constructed. The only authority source; never a request DTO. */
  readonly principals: PreparationPrincipalResolverV1;
}

/** The operations, named. No registry, no dispatch table, no `run(kind)`. */
export interface PreparationServiceV1 {
  /** Turn a plan document into a durable preparation run. */
  stage(request: StageRequestV1): Promise<StageResultV1>;
  /**
   * Answer what {@link stage} WOULD do, writing no project byte — through the
   * substrate's own forced dry-run path, so the two cannot diverge.
   *
   * It answers in its OWN vocabulary rather than staging's: a preview created no
   * run, so it reports no run identity.
   */
  preview(request: PreviewRequestV1): Promise<PreviewResultV1>;
  /** Enumerate runs and the problems observed while reading them. */
  list(): Promise<ListResultV1>;
  /**
   * Describe ONE run in the detail `list` does not carry, by reference: evidence
   * digests rather than bodies, and the execution owner's liveness uncollapsed.
   */
  show(request: ShowRequestV1): Promise<ShowResultV1>;
  /** Drive one planned run to the terminal `failed` state. */
  fail(request: FailRequestV1): Promise<FailResultV1>;
  /**
   * Publish one operator cancellation request. LOCK-FREE by design (§5 row 8) —
   * it must land when the run is wedged and everything else refuses.
   */
  cancel(request: CancelRequestV1): Promise<CancelResultV1>;
  /**
   * Hold one run at a durable safe checkpoint (§5 row 6). It refuses while an
   * attempt is in flight, because that is what the state means.
   */
  pause(request: PauseRequestV1): Promise<PauseResultV1>;
  /**
   * Return one paused run to `running` (§5 row 7) — the exit that makes
   * {@link pause} admissible.
   *
   * ORDINARY, and it costs exactly what `pause` costs. No destructive grant and
   * no cancellation route counts as the way out of a pause: a paused run is
   * escapable by a principal holding `preparation.run` and nothing more.
   */
  resume(request: ResumeRequestV1): Promise<ResumeResultV1>;
  /** Park one stranded run and report outstanding lifecycle maintenance. */
  recovery(request: RecoveryRequestV1): Promise<RecoveryResultV1>;
  /**
   * Record one host-authored gate decision and perform nothing else (§5 row 5).
   * The authority it records is consumed later, by the operation that owns the
   * work the gate governs.
   */
  gate(request: GateRequestV1): Promise<GateResultV1>;
  /**
   * Stage one settled run into its immutable Milestone A bundle, through the
   * SELF-LOCKING substrate entry point (§5 row 10).
   */
  handoff(request: HandoffRequestV1): Promise<HandoffResultV1>;
  /**
   * Reclaim one retention-eligible terminal run's exact bytes (§5 row 11). The
   * first gated DESTRUCTIVE operation: it acquires with a derived unit ticket
   * and can resume its own crashed unit, which is what keeps a crash from
   * wedging the project.
   */
  prune(request: PruneRequestV1): Promise<PruneResultV1>;
  /**
   * Reclaim the leaves of every preparation whose run is PROVABLY absent (§5
   * row 12). It takes no request: its target is the project's own registry, and
   * the exact unit it may act on is decided by the gate under the lock.
   */
  sweep(): Promise<SweepResultV1>;
  /**
   * Repair a project whose preparation key is missing or unreadable (§5 row 13).
   *
   * CLI-ONLY, and the refusal is a THROW from `service-reset.ts` rather than a
   * method this interface omits. It is declared here like every other operation
   * precisely so the restriction lives at the door instead of on the menu: a
   * host that constructs this service gets the method whatever surface it is,
   * and only the surface decides whether it works.
   *
   * Two-pass by design: the first call records an intent and returns a one-time
   * continuation secret, the second presents that secret to complete. `supersede`
   * is the exit for an operator who lost it, and it is not optional — until a
   * pending reset marker is cleared, nothing in the project can acquire the
   * mutation lock at all.
   */
  reset(request: ResetRequestV1): Promise<ResetResultV1>;
}

/**
 * Pin the host's surface to the closed transport set at construction.
 *
 * Checked at RUNTIME as well as in the type, because the SDK is a published
 * JavaScript surface: an embedder compiled against nothing at all can pass any
 * string, and an unrecognised surface must fail closed rather than become a
 * value the equality check below compares against.
 */
function fixedSurface(value: PreparationSurface): PreparationSurface {
  if (!PREPARATION_SURFACES.includes(value)) throw new PrincipalAuthorityError("invalid-principal");
  return value;
}

/**
 * Construct the preparation service for one host.
 *
 * @param deps - Root, the host's fixed surface, and its principal resolver.
 * @returns The three named operations, each authorized against the host's own
 *   principal before it does any work.
 */
export function createPreparationService(
  deps: PreparationServiceDependenciesV1,
): PreparationServiceV1 {
  const root = deps.root;
  const surface = fixedSurface(deps.surface);
  const resolver = deps.principals;
  const principalFor = resolver.principalFor.bind(resolver);

  /**
   * Capture and charge the host's principal for one operation, synchronously.
   *
   * Called in ARGUMENT POSITION below, so it completes before the operation's
   * first `await` — the capture discipline D-10-9 requires, without a second
   * copy of it in each operation module.
   */
  const authorize = (operation: PreparationGrantedOperationV1): PreparationPrincipal => {
    const captured = capturePreparationPrincipal(principalFor(operation));
    // THE FORGED-SURFACE DOOR. A resolver claiming `cli` on an `sdk` service
    // would borrow the whole local-operator grant set by transport.
    if (captured.surface !== surface) throw new PrincipalAuthorityError("invalid-principal");
    const grant = OPERATION_GRANT[operation];
    // The per-kind case charges nothing HERE and everything in `authorGateProof`,
    // which reads the kind off the authenticated plan. Charging a placeholder
    // token here would be a second authority the exact check could disagree with.
    if (grant !== PER_GATE_KIND) requirePreparationGrant(captured, grant);
    return captured;
  };

  // `async`, so an authority refusal is a REJECTED PROMISE rather than a
  // synchronous throw out of a `Promise`-returning method — a caller writing
  // `service.fail(...).catch(…)` would otherwise never see it. The capture still
  // happens in the async function's synchronous prologue, before any `await`,
  // which is what D-10-9 requires; only the throw's delivery changes.
  return {
    stage: async (request) => stagePreparationOperation(root, authorize("stage"), request),
    // NO `authorize` CALL, and the grant table is what makes that a compile-time
    // fact rather than an omission: a `null` entry removes the operation from
    // `PreparationGrantedOperationV1`, so asking the host's resolver for a
    // principal here would not type-check.
    preview: async (request) => previewPreparationOperation(root, surface, request),
    list: async () => listPreparationsOperation(root),
    show: async (request) => showPreparationOperation(root, request),
    fail: async (request) => failPreparationOperation(root, authorize("fail"), request),
    cancel: async (request) => cancelPreparationOperation(root, authorize("cancel"), request),
    pause: async (request) => pausePreparationOperation(root, authorize("pause"), request),
    resume: async (request) => resumePreparationOperation(root, authorize("resume"), request),
    recovery: async (request) => recoverPreparationOperation(root, authorize("recovery"), request),
    gate: async (request) => gatePreparationOperation(root, authorize("gate"), request),
    handoff: async (request) => handoffPreparationOperation(root, authorize("handoff"), request),
    prune: async (request) => prunePreparationOperation(root, authorize("prune"), request),
    sweep: async () => sweepPreparationOperation(root, authorize("sweep")),
    // THE SERVICE'S OWN `surface`, exactly as `preview` receives it, and never a
    // request field: the value compared against `cli` is the one the host fixed
    // at construction, so there is nothing a caller could present.
    reset: async (request) => resetPreparationOperation(root, surface, authorize("reset"), request),
  };
}

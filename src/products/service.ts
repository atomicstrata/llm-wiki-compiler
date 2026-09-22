/**
 * @file src/products/service.ts
 * @description THE product operation: a caller names an action (or one of its
 * aliases) and either PREVIEWS what it would do or INVOKES it. This is the one
 * seam that joins the four WOP V3 slices — installed package, active binding,
 * compiled plan, driven run — into something a user can call.
 *
 * IT OWNS NO SUBSTRATE AND INVENTS NO AUTHORITY. Resolution goes through
 * {@link resolveProductAction}; staging and previewing go through the frozen
 * fourteen-operation preparation service; the run is driven through the
 * production runner-input assembler and {@link runPreparation}. Nothing here
 * opens a package, binding, plan, manifest, evidence or run file.
 *
 * AUTHORITY IS DELEGATED, WHICH IS WHY THERE IS NONE TO GET WRONG HERE. The
 * preparation service charges `preparation.run` for `stage` and charges nothing
 * for `preview`; this service constructs that service with the HOST's principal
 * resolver and calls those two operations, so `invoke` costs exactly what
 * staging costs and `preview` is grant-free — by construction, not by a second
 * table that could disagree with the first. A caller that may not stage a
 * preparation may not invoke a product action either.
 *
 * THE PLAN AND THE SEED ARE HOST ARTIFACTS PRESENTED AS DOCUMENTS. The stage
 * seam takes TEXT so every surface inherits the same bounded, duplicate-key-
 * rejecting parse; the compiler's own canonical plan document and the canonical
 * bytes of the input it sealed are handed over exactly as an operator's files
 * would be. No caller-named path reaches the substrate.
 *
 * WHAT `invoke` DOES AND DOES NOT DO. It drives the certified preparation to a
 * Milestone A HANDOFF, and the bundle it produces carries a REAL reviewable
 * mutation: each of the terminal intent phase's drafts becomes one create
 * mutation whose payload is the draft's own published bytes and whose
 * postcondition is that payload's content address. It does NOT APPLY the
 * mutation — approving and applying a bundle is a separate operation — so a
 * `handed-off` result means a bundle exists proposing the change, never that an
 * entity, page or artifact was written. A terminal phase that published no
 * drafts is refused rather than handed off.
 *
 * ONE MUTATION KIND IS SUPPORTED, AND THE REST ARE REFUSED BY NAME. See
 * `operations-packs/runtime/materializer-obligation.ts`: four of the five pack
 * intent kinds require a field only the apply-time store can produce, and the
 * materializer refuses them instead of minting a digest that attests to nothing.
 *
 * A GATED RECIPE IS REFUSED, NOT DRIVEN. A gate suspends a run and only
 * re-driving that same run after an operator decision resumes it; this surface
 * stages a fresh run per call, so it declines the action on both verbs rather
 * than stranding one at a gate it has no route back from.
 */

import type { OperationAdapterMap } from "../operation-bundles/adapter-registry.js";
import type { ActionTokenRouteV1 } from "../operations-packs/aliases.js";
import type { CompiledPackActionV1 } from "../operations-packs/compiler-types.js";
import { assembleRunnerInput } from "../operations-packs/runtime/runner-input.js";
import type { PackProviderInvocationV1 } from "../operations-packs/runtime/runner-input.js";
import type { InvocationSurfaceV1, PackActionInputValueV2 } from "../operations-packs/types.js";
import type { WorkflowParentRefV1 } from "../preparations/types.js";
// Re-exported so the SDK adapter can name the parent ref through the product
// layer it already depends on, WITHOUT reaching a preparation substrate module
// directly (preparation-service-boundary allows only the service).
export type { WorkflowParentRefV1 } from "../preparations/types.js";
import type { AttemptClockV1 } from "../preparations/attempts/types.js";
import type { PreparationSurface } from "../preparations/principals.js";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { runPreparation, type RunPreparationResultV1 } from "../preparations/runner.js";
import { readPreparationEvidenceBytes } from "../preparations/evidence-store.js";
import { locatePreparationManifest } from "../preparations/service-run-lookup.js";
import {
  DEFAULT_CONTROL_TRANSITION_ALLOWANCE, createPreparationService,
} from "../preparations/service.js";
import type { PreparationPrincipalResolverV1 } from "../preparations/service.js";
import type { StageRequestV1 } from "../preparations/service-stage.js";
import { resolvePreparationRun } from "../preparations/service-run-lookup.js";
import { REQUEST_CAPTURE_REFUSAL, capturedRequest } from "../preparations/service-request-capture.js";
import { capturedOr, deepCaptureData } from "../utils/runtime-capture.js";
import { resolveProductAction, type ResolvedProductActionV1 } from "./action-resolve.js";
import { verifyWorkflowParent } from "../preparations/workflow-parent.js";
import { acquireMutationLockBlocking } from "../operation-bundles/lock-gate.js";
import { releaseLock } from "../utils/lock.js";
import type { PreparationManifestV1 } from "../preparations/manifest-parse.js";

/** What a host supplies once to build the product service for its transport. */
export interface ProductServiceDependenciesV1 {
  readonly root: string;
  /** The host's fixed transport. It is the invocation surface AND the principal's. */
  readonly surface: PreparationSurface;
  /** The host's preparation authority — the ONLY authority this service consults. */
  readonly principals: PreparationPrincipalResolverV1;
  /** The host's registered Milestone A store adapters (`createOperationRuntime`). */
  readonly adapters: OperationAdapterMap;
  readonly clock: AttemptClockV1;
  /**
   * The host's ability to execute PROVIDER phases, if it has one.
   *
   * ABSENT IS THE DEFAULT AND A REAL ANSWER: llmwiki ships no provider backend,
   * so a host that supplies nothing here runs packs whose phases are all host
   * handlers, and a provider phase settles `failed` rather than pretending. A
   * host that installs providers passes its invocation through, and the pack
   * runtime routes provider phases to it — the seal still decides WHICH
   * provider runs, so supplying this widens nothing.
   */
  readonly providerInvocation?: PackProviderInvocationV1;
}

/** One product invocation: where to record it, what to run, and with what input. */
export interface ProductInvocationRequestV1 {
  /** The workspace the durable run is recorded under. Carries no authority. */
  readonly workspaceId: string;
  /** The canonical action id, or an alias token exposed on this surface. */
  readonly token: string;
  readonly input: Readonly<Record<string, PackActionInputValueV2>>;
  /**
   * OPTIONAL one-way reference to the outer workflow run this invocation serves
   * (P6). Carries no authority; it is deep-captured before any await and grafted
   * into the canonical plan so a parent-bound run's digest covers the parent.
   */
  readonly workflowParent?: WorkflowParentRefV1;
}

/**
 * What compiling one action settled, independent of what subsequently ran.
 *
 * `planDigest` is the whole point of returning this from `preview`: an alias and
 * its canonical action must compile to the SAME digest (WOP-INV-21), and that is
 * a property a caller can check for itself.
 */
export interface CompiledActionSummaryV1 {
  readonly actionId: string;
  readonly recipeId: string;
  readonly planDigest: string;
  readonly requestedSurface: InvocationSurfaceV1;
  /** Whether the caller reached the action directly or through an alias. */
  readonly route: ActionTokenRouteV1;
}

/**
 * The closed outcome of one preview.
 *
 * `preview-refused` is a THIRD arm rather than a collapse into `refused`, and
 * the distinction is load-bearing: the action compiled — so the summary, and the
 * plan digest an alias-parity check needs, are real — and only the substrate's
 * dry run declined. A project that has never staged a preparation has no
 * integrity key to bind a manifest to, so it lands here.
 */
export type ProductPreviewResultV1 =
  | { readonly status: "previewed"; readonly action: CompiledActionSummaryV1; readonly workspaceId: string }
  | { readonly status: "preview-refused"; readonly action: CompiledActionSummaryV1; readonly reason: string }
  | { readonly status: "refused"; readonly reason: string };

/**
 * The closed outcome of one invocation. `handed-off` carries the immutable
 * Milestone A bundle the run produced; `incomplete` carries the runner's own
 * non-terminal or refused state rather than pretending the run settled.
 */
export type ProductInvokeResultV1 =
  | {
    readonly status: "handed-off";
    readonly action: CompiledActionSummaryV1;
    readonly runId: string;
    readonly bundleManifestDigest: string;
  }
  | {
    /**
     * The run reached a review gate and SUSPENDED carrying its plan. This is not
     * a failure and not a handoff: the run is waiting for a person. It names the
     * gate so the operator knows what to answer, and the run so they can answer
     * it — `llmwiki preparation gate <runId> <gateId> approved|rejected|revised`,
     * then `llmwiki product resume <runId>`.
     */
    readonly status: "awaiting-review";
    readonly action: CompiledActionSummaryV1;
    readonly runId: string;
    readonly gateIds: readonly string[];
  }
  | {
    /**
     * The run completed and there was NOTHING TO PROPOSE: every item it would
     * have drafted is already in the store. Success with no bundle — an
     * idempotent workflow re-run lands here, and reporting it as a failure
     * would teach an operator that a correct no-op is a problem.
     */
    readonly status: "nothing-to-propose";
    readonly action: CompiledActionSummaryV1;
    readonly runId: string;
    readonly reason: string;
  }
  | {
    readonly status: "incomplete";
    readonly action: CompiledActionSummaryV1;
    readonly runId: string;
    /** The runner's own status, carried verbatim rather than reclassified. */
    readonly runState: string;
    readonly reason?: string;
  }
  | { readonly status: "refused"; readonly reason: string };

/** The two product operations a host surface exposes. */
export interface ProductServiceV1 {
  /** Report what invoking this token WOULD do, writing no project byte. */
  preview(request: ProductInvocationRequestV1): Promise<ProductPreviewResultV1>;
  /** Stage the compiled action durably and drive it to its Milestone A handoff. */
  invoke(request: ProductInvocationRequestV1): Promise<ProductInvokeResultV1>;
  /**
   * Re-drive a run that suspended at its review gate, after an operator answered
   * it. The run continues where it stopped — the same durable run, the same
   * sealed sources — so an approved plan proceeds to its handoff and a `revised`
   * one recomputes against the world the operator just patched.
   */
  resume(request: ProductResumeRequestV1): Promise<ProductInvokeResultV1>;
}

/** One resume: the suspended run, and the action token it was invoked through. */
export interface ProductResumeRequestV1 {
  readonly workspaceId: string;
  readonly runId: string;
  /**
   * The same token the invocation named. It is not trusted: the service
   * recompiles the action against the run's OWN sealed input and refuses unless
   * the plan digest reproduces the one the run was staged against, so a token
   * naming a different action cannot drive someone else's run.
   */
  readonly token: string;
}

/** The compile-time facts a caller gets back on both verbs. */
function summaryOf(action: ResolvedProductActionV1): CompiledActionSummaryV1 {
  return {
    actionId: action.compiled.actionId, recipeId: action.compiled.recipeId,
    planDigest: action.compiled.planDigest, requestedSurface: action.requestedSurface,
    route: action.route,
  };
}

/**
 * Present one compiled action to the stage seam as the two documents it reads.
 *
 * The seed is the canonical serialization of the value the COMPILER resolved and
 * sealed — not the caller's input record — so the bytes staging canonicalizes
 * are by construction the ones the plan's initial input set is a digest of.
 */
function stageRequestFor(compiled: CompiledPackActionV1): StageRequestV1 {
  const planDocument = compiled.planDocument;
  const seedDocument = canonicalBytes(compiled.initialInput.value).toString("utf8");
  return {
    documents: {
      plan: () => Promise.resolve({ ok: true as const, text: planDocument }),
      seed: () => Promise.resolve({ ok: true as const, text: seedDocument }),
    },
    controlTransitionAllowance: DEFAULT_CONTROL_TRANSITION_ALLOWANCE,
  };
}

/** Project the runner's closed outcome onto the invocation vocabulary. */
function invokeOutcome(
  action: CompiledActionSummaryV1, outcome: RunPreparationResultV1,
  compiled?: CompiledPackActionV1,
): ProductInvokeResultV1 {
  if (outcome.status === "suspended-at-gate") {
    return {
      status: "awaiting-review", action, runId: outcome.runId,
      gateIds: (compiled?.plan.phases ?? []).flatMap((phase) => (phase.gate === undefined ? [] : [phase.gate.gateId])),
    };
  }
  if (outcome.status === "nothing-to-propose") {
    return { status: "nothing-to-propose", action, runId: outcome.runId, reason: outcome.reason };
  }
  if (outcome.status === "handed-off" || outcome.status === "resumed") {
    return {
      status: "handed-off", action, runId: outcome.runId,
      bundleManifestDigest: outcome.bundleManifestDigest,
    };
  }
  return {
    status: "incomplete", action, runId: outcome.runId, runState: outcome.status,
    ...("reason" in outcome ? { reason: outcome.reason } : {}),
  };
}

/** Everything driving one staged run needs, gathered so the verb stays readable. */
interface StagedDriveV1 {
  readonly root: string;
  /** The transport this invocation arrived on; provider authority binds it. */
  readonly surface: PreparationSurface;
  readonly adapters: OperationAdapterMap;
  readonly clock: AttemptClockV1;
  readonly providerInvocation?: PackProviderInvocationV1;
  readonly compiled: CompiledPackActionV1;
  readonly action: CompiledActionSummaryV1;
  readonly runId: string;
}

/**
 * Capture a host's provider invocation by VALUE at construction.
 *
 * `bind` rather than a bare reference so a method written against its own object
 * keeps working, and the result is frozen so the captured record cannot be
 * edited either. A caller that mutates its own object afterwards changes
 * nothing about a run already configured from it.
 */
function captureProviderInvocation(
  supplied: PackProviderInvocationV1 | undefined,
): PackProviderInvocationV1 | undefined {
  if (supplied === undefined) return undefined;
  const legInputFor = supplied.legInputFor.bind(supplied);
  const invoke = supplied.invoke?.bind(supplied);
  return Object.freeze({ legInputFor, ...(invoke === undefined ? {} : { invoke }) });
}

/** Locate the run just staged and drive it through the production runner. */
/**
 * Recover a suspended run's manifest and its OWN sealed input (never a
 * caller-supplied one): the bytes come from the durable evidence store under the
 * digest the plan pins, exactly where the run itself reads them. Returns the
 * manifest + parsed input, or the reason it cannot be read.
 */
async function recoverSealedResume(root: string, runId: string): Promise<
  | { ok: true; manifest: PreparationManifestV1; sealed: Readonly<Record<string, PackActionInputValueV2>> }
  | { ok: false; reason: string }
> {
  const located = await locatePreparationManifest(root, runId);
  if (!located.ok) return { ok: false, reason: located.reason };
  const inputSet = located.manifest.plan.initialInputSet;
  const read = await readPreparationEvidenceBytes(root,
    { workspaceId: located.manifest.workspaceId, preparationId: located.manifest.preparationId },
    inputSet.digest.replace(/^sha256:/, ""), inputSet.byteCount);
  if (read.status !== "ok") return { ok: false, reason: `the run's sealed input is ${read.status}` };
  const sealed = capturedOr(
    () => JSON.parse(read.bytes.toString("utf8")) as Readonly<Record<string, PackActionInputValueV2>>,
    () => null);
  if (sealed === null) return { ok: false, reason: "the run's sealed input is not a field record" };
  return { ok: true, manifest: located.manifest, sealed };
}

/** The verify/current-stage refusal for a parent-bound run, without locking. */
function parentAdmissionRefusal(
  check: Awaited<ReturnType<typeof verifyWorkflowParent>>, parent: WorkflowParentRefV1,
): { status: "refused"; reason: string } | null {
  if (check.status !== "verified") return { status: "refused", reason: `workflow-parent-${check.status}` };
  if (check.runStatus !== "running") return { status: "refused", reason: "workflow-parent-not-running" };
  if (parent.stageId !== undefined && check.currentStage !== parent.stageId) {
    return { status: "refused", reason: "workflow-parent-stage-not-current" };
  }
  return null;
}

/**
 * Refuse a parent-bound resume unless the parent is STILL running and this stage
 * is the current one — the lifecycle admission staging applies on invoke,
 * re-evaluated here. The verify/current-stage read runs UNDER the shared root
 * mutation lock (the one workflow advance/cancel take), so it is a point-in-time
 * admission the parent cannot move during; the lock is released before the
 * drive, so the documented post-admission parent-change residual remains.
 */
async function parentResumeRefusal(
  root: string, parent: WorkflowParentRefV1,
): Promise<{ status: "refused"; reason: string } | null> {
  await acquireMutationLockBlocking(root, "ordinary");
  try {
    return parentAdmissionRefusal(await verifyWorkflowParent(root, parent), parent);
  } finally {
    await releaseLock(root);
  }
}

async function driveStagedRun(drive: StagedDriveV1): Promise<ProductInvokeResultV1> {
  const located = await resolvePreparationRun(drive.root, drive.runId);
  if (!located.ok) {
    return {
      status: "incomplete", action: drive.action, runId: drive.runId,
      runState: `run-${located.failure}`, reason: located.reason,
    };
  }
  return invokeOutcome(drive.action, await runPreparation(assembleRunnerInput(drive.compiled, {
    root: drive.root, binding: located.binding, adapters: drive.adapters, clock: drive.clock,
    // The REAL surface, so a provider grant is resolved for the transport the
    // operator actually used rather than a default stamped somewhere below.
    surface: drive.surface,
    ...(drive.providerInvocation === undefined ? {} : { providerInvocation: drive.providerInvocation }),
  })), drive.compiled);
}

/**
 * Build the product service for one host surface.
 *
 * Every dependency is read into a local ONCE, in the constructor's synchronous
 * body, so a caller retaining the deps object cannot retarget the root, the
 * adapters or the clock between a request and the run it produces.
 *
 * @param deps - The project root, the host's transport, its preparation
 *   authority, its Milestone A adapters, and its clock.
 * @returns The `preview` and `invoke` operations bound to that host.
 */
export function createProductService(deps: ProductServiceDependenciesV1): ProductServiceV1 {
  const root = deps.root;
  const surface = deps.surface;
  // Pin the capability objects synchronously, the runner's own discipline
  // (`captureRunnerInput`): bind `clock.now` so replacing the method on a
  // retained `deps` cannot restamp the run's durable timestamps, and copy the
  // adapter map so a later edit to it cannot change which writers a run resolves.
  const adapters: OperationAdapterMap = new Map(deps.adapters);
  const clock: AttemptClockV1 = { now: deps.clock.now.bind(deps.clock) };
  // PINNED BY VALUE, not by reference. Storing the caller's object let them
  // replace `legInputFor` AFTER a run started — the runner reads both callables
  // when a provider phase reaches its leg, which is many awaits later — so the
  // run would execute a different invocation than the one it was configured
  // with. Capturing the functions themselves closes that window, exactly as
  // `clock.now` and the adapter map above are captured.
  const providerInvocation = captureProviderInvocation(deps.providerInvocation);
  const preparations = createPreparationService({ root, surface, principals: deps.principals });

  /**
   * Capture the caller's request by own DATA descriptors before resolving it —
   * the same discipline every preparation operation takes, and needed for the
   * same reason: a planted `token` or `workspaceId` would otherwise choose what
   * runs and where it is recorded on behalf of a caller who named neither.
   */
  async function resolve(request: ProductInvocationRequestV1) {
    const captured = capturedRequest<ProductInvocationRequestV1>(request);
    if (captured === null) return { status: "refused" as const, reason: REQUEST_CAPTURE_REFUSAL };
    // The outer capture reads `input` by own data descriptor but leaves the NESTED
    // record caller-owned, so a caller could mutate a field between here and the
    // compile/stage awaits and change the plan the run is sealed against. Deep-
    // capture rebuilds it into a frozen data-only tree that shares no reference.
    //
    // Through `capturedOr`, not a bare catch: only the CAPTURE's own refusal —
    // "this input is not data-only" — becomes a refusal about the caller's value.
    // Any other fault is a statement about this process, not about the request,
    // and reporting it as an invalid input would tell a caller its input was bad
    // when nothing established that.
    const input = capturedOr(
      () => deepCaptureData(captured.input) as Readonly<Record<string, PackActionInputValueV2>>,
      () => null);
    if (input === null) return { status: "refused" as const, reason: REQUEST_CAPTURE_REFUSAL };
    // The nested `workflowParent` is caller-owned exactly like `input`, so it is
    // deep-captured the same way BEFORE any await — a caller must not be able to
    // mutate the parent ref between here and the canonical plan graft/staging.
    const parentRaw = captured.workflowParent;
    const workflowParent = parentRaw === undefined
      ? undefined
      : capturedOr(() => deepCaptureData(parentRaw) as WorkflowParentRefV1, () => null);
    if (workflowParent === null) return { status: "refused" as const, reason: REQUEST_CAPTURE_REFUSAL };
    return resolveProductAction(root, {
      workspaceId: captured.workspaceId, token: captured.token, surface, input,
      ...(workflowParent === undefined ? {} : { workflowParent }),
    });
  }

  return {
    preview: async (request) => {
      const resolved = await resolve(request);
      if (resolved.status === "refused") return { status: "refused", reason: resolved.reason };
      const action = summaryOf(resolved.action);
      const previewed = await preparations.preview(stageRequestFor(resolved.action.compiled));
      return previewed.status === "previewed"
        ? { status: "previewed", action, workspaceId: previewed.workspaceId }
        : { status: "preview-refused", action, reason: previewed.reason };
    },

    invoke: async (request) => {
      const resolved = await resolve(request);
      if (resolved.status === "refused") return { status: "refused", reason: resolved.reason };
      const action = summaryOf(resolved.action);
      const staged = await preparations.stage(stageRequestFor(resolved.action.compiled));
      if (staged.status !== "staged") return { status: "refused", reason: staged.reason };
      return driveStagedRun({
        root, adapters, clock, providerInvocation, surface,
        compiled: resolved.action.compiled, action, runId: staged.runId,
      });
    },

    resume: async (request) => {
      const captured = capturedRequest<ProductResumeRequestV1>(request);
      if (captured === null) return { status: "refused" as const, reason: REQUEST_CAPTURE_REFUSAL };
      const recovered = await recoverSealedResume(root, captured.runId);
      if (!recovered.ok) return { status: "refused", reason: recovered.reason };
      // Recompile from the run's OWN sealed input, and graft the sealed plan's
      // workflowParent (if any) into the SAME compile request — the parent is
      // part of the canonical plan the digest covers, so a parent-bound run
      // reproduces its planDigest ONLY when resume reconstructs it. Without this
      // a parent-bound run is unresumable (P6.2 / plan finding 3).
      const sealedParent = recovered.manifest.plan.workflowParent;
      const resolved = await resolveProductAction(root, {
        workspaceId: captured.workspaceId, token: captured.token, surface, input: recovered.sealed,
        ...(sealedParent === undefined ? {} : { workflowParent: sealedParent }),
      });
      if (resolved.status === "refused") return { status: "refused", reason: resolved.reason };
      // THE GUARD: the recompiled plan must be byte-identical to the one this run
      // was staged against. Compilation is deterministic, so a match proves the
      // token names this run's action and a mismatch proves it does not.
      if (resolved.action.compiled.planDigest !== recovered.manifest.planDigest) {
        return { status: "refused", reason: "that action does not reproduce this run's sealed plan" };
      }
      // ADMISSION RE-CHECK before drive: a parent-bound run may be resumed only
      // while its parent is still running AND this stage is current — the same
      // lifecycle gate staging applies on invoke, re-evaluated immediately before
      // the resume drives (plan v8 finding 1).
      const resumeRefusal = sealedParent === undefined ? null : await parentResumeRefusal(root, sealedParent);
      if (resumeRefusal !== null) return resumeRefusal;
      // RESUME DRIVES TOO, so it needs the same capability: a run suspended at a
      // gate and then resumed must be able to execute the provider phases the
      // original drive could, or resuming would silently degrade the run.
      return driveStagedRun({
        root, adapters, clock, providerInvocation, surface,
        compiled: resolved.action.compiled,
        action: summaryOf(resolved.action), runId: captured.runId,
      });
    },
  };
}

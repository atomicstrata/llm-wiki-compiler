/**
 * @file src/products/apply.ts
 * @description THE second half of the product vertical: `invoke` PROPOSES a
 * bundle, and this seam APPROVES AND APPLIES it. It is the first production
 * caller of {@link approveAndApplyOperationBundleLocked} — until now that
 * executor was reachable only from test fixtures.
 *
 * IT IS DELIBERATELY THIN, AND THE THINNESS IS THE DESIGN. There is no product
 * approval protocol, no product-scoped durable state, and no second authority
 * table. Applying a product's bundle IS applying an operation bundle: the same
 * `operation-bundle.approve` grant, the same project lock, the same recovery
 * gate, the same manifest-order mutation protocol, and the same retry/resume
 * semantics an operator already has through `llmwiki operation resume`. A
 * product-specific copy of any of those would be a second thing to keep correct
 * and a second thing to get wrong.
 *
 * NOTHING ABOUT THE TARGET IS FABRICATED. The caller names a bundle the only way
 * it can — the run id or bundle id a surface printed — and every identity the
 * executor is handed (`workspaceId`, `bundleId`, `manifestDigest`) is read back
 * off the manifest the durable store loaded, through the shared
 * {@link resolveTarget}. The digest in particular is RECOMPUTED from those bytes
 * rather than remembered from the invocation that produced them, so a bundle
 * whose manifest changed underneath the caller is refused by the executor's own
 * digest check instead of applied against a stale expectation.
 *
 * AUTHORITY IS INJECTED, NEVER CONSTRUCTED HERE, exactly as the product service
 * takes its adapters rather than building them. The host supplies the principal
 * and the runtime, so this module cannot widen what a surface may do: the local
 * CLI passes an operator principal and the CLI runtime that carries the
 * production authority resolver, and the SDK passes what it actually holds,
 * which today is neither (see `sdk/product-facade.ts`).
 *
 * THE OUTCOME IS PROJECTED, NOT RECLASSIFIED. `applied` is reserved for the two
 * terminal states in which the authoritative mutations actually landed; every
 * other settled state — a park at `recovery-required`, a missing grant, an
 * invalidated approval — is carried verbatim in `not-applied` with the
 * executor's own state string and problem codes. A caller must never be able to
 * read a non-applied outcome as a write.
 *
 * `applied` IS A POSTCONDITION, NOT AN EVENT, and a caller must not read it as
 * one. The executor answers a wrong-state call by returning the run's REAL
 * state with no problem attached, so applying an already-settled bundle returns
 * a result byte-identical to the one that settled it — same terminal state, same
 * counters, no problems. There is no field in {@link OperationActionResult} that
 * distinguishes "this call applied it" from "it was already applied", and this
 * seam refuses to invent one by reading the run a second time through a
 * different path than the executor's. So `applied` means the bundle IS applied,
 * a second apply is idempotent, and the counters describe the run that settled
 * it rather than this call.
 */

import type { OperationRuntime } from "../operation-bundles/adapter-registry.js";
import {
  loadOperationInventory, resolveTarget, type ResolvedTarget,
} from "../operation-bundles/bundle-target.js";
import {
  approveAndApplyOperationBundleLocked, type OperationActionResult,
} from "../operation-bundles/executor.js";
import { acquireMutationLock, RecoveryGateError } from "../operation-bundles/lock-gate.js";
import type { OperationPrincipal } from "../operation-bundles/principal.js";
import type { OperationRunState } from "../operation-bundles/run-types.js";
import { REQUEST_CAPTURE_REFUSAL, capturedRequest } from "../preparations/service-request-capture.js";
import { JournalUnsafeError } from "../trust/journal-recovery.js";
import { releaseLock } from "../utils/lock.js";

/** What a host supplies to apply one product bundle on its transport. */
export interface ProductApplyDependenciesV1 {
  readonly root: string;
  /**
   * The host's operation principal. Approving charges `operation-bundle.approve`
   * — an OPERATION grant, deliberately not the `preparation.run` grant `invoke`
   * costs, because proposing a change and authorizing it are different powers.
   */
  readonly principal: OperationPrincipal;
  /**
   * The host's operation runtime: its store adapters, clock, and the authority
   * provider that recomputes the approval snapshot. This is the ONLY place the
   * power to apply enters, and it is the host's to grant or withhold.
   */
  readonly runtime: OperationRuntime;
}

/** One product apply: the bundle a caller names, and nothing else. */
export interface ProductApplyRequestV1 {
  /**
   * The bundle manifest digest, bundle id, or operation run id a surface
   * reported — `invoke` prints the first of those. Carries no authority: it
   * selects WHICH proposal is applied, never whether it may be.
   */
  readonly bundle: string;
}

/** One bounded problem the executor reported, carried verbatim. */
export interface ProductApplyProblemV1 {
  readonly code: string;
  readonly message: string;
}

/**
 * How the bundle's authoritative mutations settled, carried verbatim from the
 * run's own counters.
 *
 * IT IS REPORTED BECAUSE `applied` AND `skipped` ARE DIFFERENT ANSWERS about the
 * caller's wiki. A skipped mutation is `skipped-idempotent`: the target was
 * already in its exact post-state, so the run wrote nothing and merely found the
 * page there. Both settle the run successfully, and an operator asking "did this
 * create my page?" is asking precisely which of the two happened.
 */
export interface ProductApplyMutationsV1 {
  readonly attempted: number;
  readonly applied: number;
  readonly skipped: number;
  readonly failed: number;
}

/**
 * The closed outcome of one apply.
 *
 * `applied` means the wiki CHANGED. `not-applied` carries the executor's own
 * settled state rather than pretending the run finished, and `refused` covers
 * the reasons the executor was never reached at all.
 */
export type ProductApplyResultV1 =
  | {
    readonly status: "applied";
    readonly bundleId: string;
    readonly runId: string;
    /** The executor's own terminal state, carried verbatim. */
    readonly runState: string;
    readonly mutations: ProductApplyMutationsV1;
    readonly problems: readonly ProductApplyProblemV1[];
  }
  | {
    readonly status: "not-applied";
    readonly bundleId: string;
    readonly runId?: string;
    /** The executor's own state, carried verbatim rather than reclassified. */
    readonly runState?: string;
    /** Absent when the run was never resolved far enough to have counters. */
    readonly mutations?: ProductApplyMutationsV1;
    readonly problems: readonly ProductApplyProblemV1[];
  }
  | { readonly status: "refused"; readonly reason: string };

/**
 * The two terminal states in which every authoritative mutation of the bundle
 * verified — the only two that may be reported as a write.
 *
 * `succeeded-with-warnings` belongs here and the warning is not a hedge about
 * the write: a warning is recorded only for an incomplete OPTIONAL projection,
 * which is a derived view. The authoritative mutations still applied and
 * verified, so the page exists. Every other terminal (`cancelled`, `compensated`,
 * `recovered`, `failed`, `rejected`, `abandoned`) and every unsettled state is
 * NOT an apply, and the `runState` carried alongside says which it was.
 */
const APPLIED_TERMINAL_STATES: ReadonlySet<OperationRunState> = new Set([
  "succeeded",
  "succeeded-with-warnings",
]);

/** The lock intent an approval takes: a reviewed decision, not a recovery re-drive. */
const APPLY_LOCK_INTENT = "review" as const;

/** Carry the executor's bounded problems into the product vocabulary unchanged. */
function carriedProblems(result: OperationActionResult): ProductApplyProblemV1[] {
  return result.problems.map((problem) => ({ code: problem.code, message: problem.message }));
}

/** Carry the run's own authoritative-mutation counters, when the run resolved. */
function carriedMutations(result: OperationActionResult): ProductApplyMutationsV1 | undefined {
  const counters = result.counters?.mutations;
  if (counters === undefined) return undefined;
  return {
    attempted: counters.attempted, applied: counters.applied,
    skipped: counters.skipped, failed: counters.failed,
  };
}

/** Whether this settled result is one in which the bundle's mutations landed. */
function reachedAppliedTerminal(result: OperationActionResult): boolean {
  return result.problems.length === 0
    && result.state !== undefined
    && APPLIED_TERMINAL_STATES.has(result.state)
    && result.runId !== undefined
    && result.counters !== undefined;
}

/**
 * Project one closed {@link OperationActionResult} onto the product vocabulary.
 *
 * The state, counters and problems cross unchanged; only the ARM is decided
 * here, and it is decided by the executor's own terminal state plus the absence
 * of any problem — never by whether the call threw or returned.
 */
function applyOutcome(result: OperationActionResult): ProductApplyResultV1 {
  const problems = carriedProblems(result);
  const mutations = carriedMutations(result);
  if (reachedAppliedTerminal(result) && mutations !== undefined) {
    return {
      status: "applied", bundleId: result.bundleId, runId: result.runId as string,
      runState: result.state as string, mutations, problems,
    };
  }
  return {
    status: "not-applied", bundleId: result.bundleId, problems,
    ...(result.runId === undefined ? {} : { runId: result.runId }),
    ...(result.state === undefined ? {} : { runState: result.state }),
    ...(mutations === undefined ? {} : { mutations }),
  };
}

/**
 * Acquire the project lock under the apply intent and run the executor, or
 * report why the lock was never taken.
 *
 * BOTH WAYS THE GATED ACQUISITION DECLINES ARE ANSWERS, the discipline
 * `service-stage.ts` records: `acquireMutationLock` is not a mutex, and its gate
 * THROWS one of two typed refusals — `JournalUnsafeError` when a page journal is
 * unsafe, `RecoveryGateError` when another bundle needs recovery first. Letting
 * either escape would surface a stack trace where an operator needs a sentence,
 * so each gate-refusal class becomes a refusal carrying the gate's own message.
 * Any other error is a statement about this process and stays visible.
 */
async function underApplyLock(
  root: string, action: () => Promise<OperationActionResult>,
): Promise<ProductApplyResultV1> {
  let acquired: boolean;
  try {
    acquired = await acquireMutationLock(root, APPLY_LOCK_INTENT);
  } catch (error) {
    if (error instanceof RecoveryGateError || error instanceof JournalUnsafeError) {
      return { status: "refused", reason: error.message };
    }
    throw error;
  }
  if (!acquired) return { status: "refused", reason: "project lock is busy" };
  try {
    return applyOutcome(await action());
  } finally {
    await releaseLock(root);
  }
}

/** Resolve the named target from the durable inventory, or say it matched nothing. */
async function resolveApplyTarget(
  root: string, bundle: string,
): Promise<ResolvedTarget | { readonly reason: string }> {
  const resolved = resolveTarget(await loadOperationInventory(root), bundle);
  return resolved ?? { reason: `No operation bundle or run matches "${bundle}".` };
}

/**
 * Approve and apply one bundle a product invocation proposed.
 *
 * UNLIKE `invoke`, THIS WRITES. A settled `applied` means the bundle's mutations
 * ran against the authoritative stores and verified — the page exists on disk.
 *
 * It adds no protocol of its own: the resolution, the lock, the gate, the
 * approval, the apply and the recovery semantics are all the operation-bundle
 * machinery's, reached through {@link approveAndApplyOperationBundleLocked}. A
 * bundle that parks is resumable exactly as any other parked bundle is, through
 * `llmwiki operation resume`, because it IS one.
 *
 * @param deps - The project root, the host's operation principal, and the
 *   host's operation runtime (which carries the authority to approve at all).
 * @param request - The run id or bundle id naming the proposal to apply.
 * @returns The applied / not-applied / refused outcome, with the executor's own
 *   state and problems carried verbatim.
 */
export async function applyProductBundle(
  deps: ProductApplyDependenciesV1, request: ProductApplyRequestV1,
): Promise<ProductApplyResultV1> {
  // Captured by own DATA descriptors before anything reads it, the discipline
  // every preparation and product operation takes: a planted `bundle` accessor
  // would otherwise choose which proposal is applied on behalf of a caller who
  // named a different one.
  const captured = capturedRequest<ProductApplyRequestV1>(request);
  if (captured === null) return { status: "refused", reason: REQUEST_CAPTURE_REFUSAL };
  const resolved = await resolveApplyTarget(deps.root, captured.bundle);
  if ("reason" in resolved) return { status: "refused", reason: resolved.reason };
  return underApplyLock(deps.root, () => approveAndApplyOperationBundleLocked(deps.root, {
    workspaceId: resolved.workspaceId,
    bundleId: resolved.bundleId,
    manifestDigest: resolved.manifestDigest,
    principal: deps.principal,
    runtime: deps.runtime,
  }));
}

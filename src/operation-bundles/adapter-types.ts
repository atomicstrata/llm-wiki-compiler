/**
 * @file src/operation-bundles/adapter-types.ts
 * @description The closed store-adapter contract shared by all seven mutation
 * kinds (V2 §6.3), the five-way observation vocabulary, and the fault injector
 * boundary set (§26.6). Adapters are core-built closures over authoritative
 * store seams: no adapter is deserialized from manifest data, no adapter reaches
 * another adapter, and each adapter narrows to its one declared mutation kind.
 */

import type { OperationAuditBinding } from "./audit-binding.js";
import type { OperationAuthoritySnapshot } from "./authority.js";
import type { CompensationId, MutationId } from "./ids.js";
import type { OperationProblemCode } from "./problems.js";
import type { Clock } from "./stage.js";
import type { OperationBundleManifest, OperationDigest, OperationMutation } from "./types.js";

/** The mutation shape carried by an adapter declaring exactly one kind. */
export type MutationOfKind<K extends OperationMutation["kind"]> = Extract<OperationMutation, { kind: K }>;

/**
 * The five and only observation outcomes. `unavailable` (an unreadable store)
 * never collapses into `not-applied`; `partially-applied` means the authority
 * record landed but its required child audit did not.
 */
export type ObservationOutcome =
  | "not-applied" | "applied" | "partially-applied" | "conflict" | "unavailable";

/** Exact observed state plus the digest evidence recovery compares against. */
export interface OperationObservation {
  outcome: ObservationOutcome;
  /** The authoritative post-state digest when the effect is present. */
  postStateDigest?: OperationDigest;
  /** True for `partially-applied`: only the child audit event must be repaired. */
  auditRepairOnly?: boolean;
  /**
   * For an `applied` outcome, whether the present effect is BOUND to THIS mutation
   * (an authority record or child event carrying this mutationId) — i.e. this run
   * produced it. False/absent means present-but-unbound (a pre-existing effect, or
   * a content/recipe-addressed target with no per-mutation binding). Crash recovery
   * upgrades a started mutation to `applied` only when this is true; otherwise the
   * idempotent skip stays `skipped-idempotent` and out of the compensation set.
   */
  boundToMutation?: boolean;
  /**
   * Bounded reason for `partially-applied`, `conflict`, or `unavailable` — and,
   * for an UNBOUND `applied`, what actually satisfies the postcondition (e.g.
   * the pre-existing record id a same-content relation deduped to), so a
   * recovery-derived skip keeps the forward path's observable claim boundary.
   */
  detail?: string;
}

/** Preflight authority, store health, namespace, grammar, and bounds. */
export type AdapterPreflight =
  | { status: "ready" }
  | { status: "park"; code: OperationProblemCode; detail: string }
  | { status: "unavailable"; detail: string };

/**
 * The result of invoking the authoritative store seam. `applied` is unambiguously
 * this run's effect. `skipped-idempotent` carries `boundToMutation`: true when the
 * already-present effect is bound to this mutation (this run produced it, so a
 * crash recovery records `applied`), false when it is a pre-existing/unbound
 * target (records `skipped-idempotent`, never entering the compensation set).
 */
export type AdapterApply =
  | { status: "applied"; postStateDigest: OperationDigest; evidence?: Buffer }
  // A DELETE has no post-state to digest. It gets its own arm rather than
  // loosening `applied`, so every other mutation kind's success contract stays
  // exactly as it was — none of them asked for an optional post-state, and a
  // nullable digest would let a missing one pass unnoticed on paths that must
  // always have it.
  | { status: "applied-absent" }
  // `detail` names what actually satisfied the postcondition when it was not
  // this mutation's own write — e.g. the pre-existing record id a same-content
  // relation deduped to — so the skip's claim boundary is observable.
  | { status: "skipped-idempotent"; postStateDigest: OperationDigest; boundToMutation: boolean; detail?: string }
  | { status: "conflict"; detail: string }
  | { status: "unavailable"; detail: string };

/** Proof that the declared postcondition holds after apply. */
export type AdapterVerify =
  | { status: "verified"; postStateDigest: OperationDigest }
  /** The declared absence holds: the target is gone after apply. */
  | { status: "verified-absent" }
  | { status: "mismatch"; detail: string }
  | { status: "unavailable"; detail: string };

/** The result of one allowlisted idempotent compensator. */
export type AdapterCompensate =
  | { status: "reverted" }
  | { status: "already-reverted" }
  | { status: "conflict"; detail: string }
  | { status: "unavailable"; detail: string };

/** Everything one adapter method needs for exactly one mutation of its kind. */
export interface AdapterContext<M extends OperationMutation = OperationMutation> {
  root: string;
  workspaceId: string;
  manifest: OperationBundleManifest;
  mutation: M;
  authority: OperationAuthoritySnapshot;
  auditBinding: OperationAuditBinding;
  clock: Clock;
  fault?: OperationFaultInjector;
}

/** The five-method authoritative adapter contract, over the mutation union. */
export interface OperationStoreAdapter {
  readonly kind: OperationMutation["kind"];
  preflight(ctx: AdapterContext): Promise<AdapterPreflight>;
  observe(ctx: AdapterContext): Promise<OperationObservation>;
  apply(ctx: AdapterContext): Promise<AdapterApply>;
  verify(ctx: AdapterContext): Promise<AdapterVerify>;
  compensate?(ctx: AdapterContext): Promise<AdapterCompensate>;
}

/** The kind-narrowed implementation an adapter author writes for one kind. */
export interface OperationStoreAdapterImpl<K extends OperationMutation["kind"]> {
  readonly kind: K;
  preflight(ctx: AdapterContext<MutationOfKind<K>>): Promise<AdapterPreflight>;
  observe(ctx: AdapterContext<MutationOfKind<K>>): Promise<OperationObservation>;
  apply(ctx: AdapterContext<MutationOfKind<K>>): Promise<AdapterApply>;
  verify(ctx: AdapterContext<MutationOfKind<K>>): Promise<AdapterVerify>;
  compensate?(ctx: AdapterContext<MutationOfKind<K>>): Promise<AdapterCompensate>;
}

/** Narrow the union context to one kind, failing closed on a foreign mutation. */
function narrowContext<K extends OperationMutation["kind"]>(
  kind: K,
  ctx: AdapterContext,
): AdapterContext<MutationOfKind<K>> {
  if (ctx.mutation.kind !== kind) {
    throw new Error(`operation adapter ${kind} received a ${ctx.mutation.kind} mutation`);
  }
  return ctx as AdapterContext<MutationOfKind<K>>;
}

/**
 * Wrap a kind-narrowed implementation into a union-typed adapter that guards its
 * own context kind at every call. This is the only way an adapter is built, so a
 * mismatched mutation cannot reach a kind's store seam even when routed wrongly.
 */
export function defineOperationStoreAdapter<K extends OperationMutation["kind"]>(
  impl: OperationStoreAdapterImpl<K>,
): OperationStoreAdapter {
  const kind = impl.kind;
  return {
    kind,
    preflight: (ctx) => impl.preflight(narrowContext(kind, ctx)),
    observe: (ctx) => impl.observe(narrowContext(kind, ctx)),
    apply: (ctx) => impl.apply(narrowContext(kind, ctx)),
    verify: (ctx) => impl.verify(narrowContext(kind, ctx)),
    ...(impl.compensate === undefined
      ? {}
      : { compensate: (ctx: AdapterContext) => impl.compensate!(narrowContext(kind, ctx)) }),
  };
}

/**
 * Deterministic crash and cancellation seams placed at every transition and
 * adapter boundary. The injector is core-constructed for tests only and never
 * exported to a public surface. Transition boundaries carry the transition label;
 * mutation boundaries carry the mutation identity; the compensate and cancel
 * boundaries exist so later chunks can exercise compensation and cancellation
 * faults even though Task 1 only defines them.
 */
export interface OperationFaultInjector {
  beforeTransitionWrite?(label: string): Promise<void>;
  afterTransitionWrite?(label: string): Promise<void>;
  beforePreflight?(mutationId: MutationId): Promise<void>;
  beforeObserve?(mutationId: MutationId): Promise<void>;
  beforeApply?(mutationId: MutationId): Promise<void>;
  afterApply?(mutationId: MutationId): Promise<void>;
  beforeVerify?(mutationId: MutationId): Promise<void>;
  beforeEvidenceWrite?(mutationId: MutationId): Promise<void>;
  beforeAuditAppend?(mutationId: MutationId): Promise<void>;
  beforeProjectionWrite?(mutationId: MutationId): Promise<void>;
  beforeTerminalWrite?(): Promise<void>;
  beforeCompensate?(compensationId: CompensationId): Promise<void>;
  afterCompensate?(compensationId: CompensationId): Promise<void>;
  atCancelSafePoint?(mutationId: MutationId): Promise<void>;
}

/**
 * @file src/capability-providers/host/grant.ts
 * @description Issuing the operator grant a development provider runs under,
 * and building the effective-grant request that names it.
 *
 * A GRANT IS THE OPERATOR'S SENTENCE, NOT THE PACK'S. A pack REQUESTS authority
 * and bounds; what a provider actually gets is the intersection of that request
 * with this grant and with the host floor. This helper writes the operator's
 * half through `writeOperatorGrant` — the platform's sole grant transaction,
 * which recomputes the confirmation digest and refuses a mismatch — so a
 * development grant is the same record as any other and there is no
 * development-only authority path.
 *
 * THE RECORD BINDS ITSELF TO EXACTLY ONE PROVIDER AND ONE PROJECT. The resolver
 * re-derives the pin digest and the request digest and refuses any drift, so a
 * grant issued for one provider cannot be spent by another, and one issued in
 * one project cannot be spent in another. Both digests are therefore DERIVED
 * here through the platform's own claim function rather than assembled, because
 * a hand-built digest that happened to differ would fail as "grant has drifted"
 * — a message that describes tampering, not a typo, and would send a developer
 * hunting the wrong problem.
 *
 * THE DEFAULT SCOPE GRANTS NOTHING BEYOND RUNNING. A provider that only reads
 * its request and answers needs no broker, no credential, and no mutating
 * effect, so the default authority list is EMPTY and the caller must add atoms
 * deliberately. Bounds are still real numbers because a bound of zero would
 * refuse the invocation outright.
 */

import {
  operatorGrantRequestDigest, projectGrantScopeDigest, writeOperatorGrant,
} from "../authority/grants-resolve.js";
import { readProviderGrantState } from "../authority/grants-store.js";
import type {
  EffectiveProviderGrantRequestV1, ProviderAuthorityAtomV1, ProviderEffectPlanV1,
  ProviderGrantScopeV1, ProviderOperatorGrantRecordV1,
} from "../authority/types.js";
import type { AuthorizedProviderPaths } from "../packages/paths.js";
import { parseBrokerId, parseSha256Digest } from "../ids.js";
import type { Sha256Digest } from "../types.js";
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import type { ProviderBoundsV1, ProviderPinV1 } from "../types.js";

/** Per-invocation ceilings a development provider runs under. */
export const DEV_PROVIDER_BOUNDS: ProviderBoundsV1 = Object.freeze({
  structuredInputBytes: 1 << 20, materializedInputFiles: 16, materializedInputBytes: 1 << 22,
  scratchFiles: 32, scratchBytes: 1 << 22, outputFiles: 16, outputBytes: 1 << 22,
  custodyScanBytes: 1 << 24, custodyWallTimeMs: 30_000, protocolFrames: 256,
  protocolBytes: 1 << 22, brokerRequests: 0, mutatingEffects: 0,
  wallTimeMs: 60_000, cpuTimeMs: 60_000, memoryBytes: 1 << 30, processCount: 1,
});

/** One grant scope: what is allowed, and the ceilings it is allowed within. */
/**
 * The authority atom that lets a provider READ materialized source evidence of
 * one input kind. A grant without it refuses any invocation whose exposure
 * carries files — reading retained sources is part of the operator's sentence,
 * never something a pack's descriptor can claim for itself.
 */
export function devSourceReadAuthority(inputKind: string): ProviderAuthorityAtomV1 {
  return Object.freeze({
    kind: "source.read", brokerId: null, operation: "read", target: null, method: null,
    credentialSlotId: null, credentialHandleId: null, effectClass: null,
    inputKind, toolId: null,
  });
}

/**
 * The authority atom that lets a provider make ONE KIND of model call through
 * the host's broker. `operation` and `target` are exact — the operator grants
 * "complete-summary against test-service/test-model", never "any model" — and
 * the grant's bounds and brokerMaximums still cap every request.
 */
export function devModelInvokeAuthority(operation: string, target: string): ProviderAuthorityAtomV1 {
  return Object.freeze({
    kind: "model.invoke", brokerId: parseBrokerId("model"), operation, target, method: null,
    credentialSlotId: null, credentialHandleId: null, effectClass: null,
    inputKind: null, toolId: null,
  });
}

export function devGrantScope(
  authority: readonly ProviderAuthorityAtomV1[] = [],
  bounds: ProviderBoundsV1 = DEV_PROVIDER_BOUNDS,
): ProviderGrantScopeV1 {
  return Object.freeze({ schemaVersion: 1, authority: Object.freeze([...authority]), bounds });
}

/**
 * An effect plan claiming nothing: a provider that only answers has no effects.
 * Internal, because a caller with real effects builds a plan describing them
 * rather than starting from an empty one.
 */
function devEffectPlan(bounds: ProviderBoundsV1 = DEV_PROVIDER_BOUNDS): ProviderEffectPlanV1 {
  return Object.freeze({ schemaVersion: 1, bounds, entries: Object.freeze([]) });
}

/** What issuing one development grant needs. */
export interface IssueDevGrantRequestV1 {
  readonly pin: ProviderPinV1;
  /** The project directory the grant is spendable in; it must exist. */
  readonly projectRoot: string;
  readonly grantId: string;
  readonly scope?: ProviderGrantScopeV1;
  readonly createdAt?: string;
}

/** The issued grant's identity, as an effective-grant request must name it. */
export interface IssuedDevGrantV1 {
  readonly grantId: string;
  readonly revision: number;
  readonly grantRequestDigest: string;
  readonly projectRealpathDigest: string;
  readonly scope: ProviderGrantScopeV1;
}

/** The grant already recorded under this id, when there is one. */
async function existingGrant(
  paths: AuthorizedProviderPaths, grantId: string,
): Promise<ProviderOperatorGrantRecordV1 | undefined> {
  const read = await readProviderGrantState(paths);
  return read.kind === "ok" ? read.state.grants[grantId] : undefined;
}

/**
 * Issue the operator grant a development provider will run under.
 *
 * @param paths - The host's authorized provider roots.
 * @param request - The provider pin, the project it is spendable in, and scope.
 * @returns The grant identity an effective-grant request must carry.
 */
export async function issueDevProviderGrant(
  paths: AuthorizedProviderPaths, request: IssueDevGrantRequestV1,
): Promise<IssuedDevGrantV1> {
  const scope = request.scope ?? devGrantScope();
  // The project digest is derived from the REAL directory, so a grant cannot be
  // bound to a path that does not exist or to an uncanonicalized alias of one.
  const projectRealpathDigest = await projectGrantScopeDigest(request.projectRoot);
  // Derived through the platform's OWN claim function, then handed back to the
  // platform as the operator's confirmation: `writeOperatorGrant` recomputes it
  // and refuses a mismatch, so this cannot become a private digest convention.
  const grantRequestDigest = operatorGrantRequestDigest(request.pin, scope, projectRealpathDigest);
  // RE-ISSUING THE SAME GRANT IS A NO-OP, because a provider module runs on
  // EVERY invocation and the store refuses a grant id that already exists. A
  // module that issued unconditionally would work once and then fail with
  // "provider grant already exists" — which reads as corruption rather than as
  // the second run it actually is.
  //
  // CREATE FIRST, RECONCILE ON CONFLICT — never read-then-write. A read outside
  // the store's own lock is a race: two concurrent identical calls both observe
  // absence, one writes, and the other still fails. Attempting the write makes
  // the store's transaction the arbiter, and the loser re-reads what the winner
  // committed.
  return createOrReuseGrant(paths, request, scope, projectRealpathDigest, grantRequestDigest);
}

/** Attempt the write; on an id conflict, reuse an existing IDENTICAL grant. */
async function createOrReuseGrant(
  paths: AuthorizedProviderPaths, request: IssueDevGrantRequestV1,
  scope: ProviderGrantScopeV1, projectRealpathDigest: Sha256Digest,
  grantRequestDigest: Sha256Digest,
): Promise<IssuedDevGrantV1> {
  try {
    const record = await writeOperatorGrant(paths, {
      grantId: request.grantId, projectRoot: request.projectRoot, providerPin: request.pin,
      grant: scope, confirmedGrantRequestDigest: grantRequestDigest,
      createdAt: request.createdAt ?? new Date(0).toISOString(),
    });
    return {
      grantId: record.grantId, revision: record.revision,
      grantRequestDigest: record.grantRequestDigest, projectRealpathDigest, scope,
    };
  } catch (error) {
    if (!/already exists/.test((error as Error).message)) throw error;
    const existing = await existingGrant(paths, request.grantId);
    // "The same" is CHECKED, not assumed: an id reused for a different provider
    // or project is a genuine conflict and still refuses.
    if (existing === undefined || existing.projectRealpathDigest !== projectRealpathDigest
      || existing.grantRequestDigest !== grantRequestDigest) {
      throw new Error(`provider grant ${request.grantId} already exists for a different provider or project`);
    }
    return {
      grantId: existing.grantId, revision: existing.revision,
      grantRequestDigest: existing.grantRequestDigest, projectRealpathDigest, scope,
    };
  }
}

/** What the effective-grant request needs beyond the issued grant itself. */
export interface DevGrantRequestContextV1 {
  /** The digest of the operator's pinned price table, when model calls are granted. */
  readonly priceTableDigest?: Sha256Digest;
  readonly pin: ProviderPinV1;
  readonly workspaceId: string;
  readonly preparationRunId: string;
  /**
   * The transport the operator invoked through.
   *
   * NOT A CONSTANT. Authority is read from the surface, so stamping `sdk` on a
   * CLI invocation resolves a grant for a transport the operator never used.
   */
  readonly surface: "cli" | "sdk" | "mcp";
  /**
   * The project this invocation actually runs in, derived from the RUN's root.
   *
   * Not taken from the issued grant: copying the grant's own digest would make
   * the resolver's project check compare a value against itself.
   */
  readonly projectRealpathDigest: string;
  readonly safetyFloorVersion: string;
  /** What the PACK asks for; the effective grant is this intersected down. */
  readonly operationsPackRequest?: ProviderGrantScopeV1;
  readonly effectPlan?: ProviderEffectPlanV1;
}

/**
 * Build the effective-grant request naming one issued grant.
 *
 * @param issued - The grant issued by {@link issueDevProviderGrant}.
 * @param context - The run identity and the pack's requested scope.
 * @returns The request the provider runtime resolves an effective grant from.
 */
export function devEffectiveGrantRequest(
  issued: IssuedDevGrantV1, context: DevGrantRequestContextV1,
): EffectiveProviderGrantRequestV1 {
  const requested = context.operationsPackRequest ?? issued.scope;
  return {
    schemaVersion: 1, providerPin: context.pin,
    projectRealpathDigest: parseSha256Digest(context.projectRealpathDigest),
    capabilityId: context.pin.capabilityId, workspaceId: context.workspaceId,
    preparationRunId: context.preparationRunId, surface: context.surface,
    safetyFloorVersion: context.safetyFloorVersion,
    // The floor and the provider maximum are the SAME scope here because a
    // development host imposes no policy of its own: the effective grant is
    // then exactly the pack's request capped by the operator's grant, which is
    // the relationship a real host tightens rather than invents.
    hostFloor: issued.scope, providerMaximum: issued.scope, operationsPackRequest: requested,
    operatorGrantId: issued.grantId, operatorGrantRevision: issued.revision,
    operatorGrantRequestDigest: parseSha256Digest(issued.grantRequestDigest),
    // A provider that only answers plans NO effects, prices nothing, and is
    // exposed to no retained input; each is stated rather than defaulted so a
    // caller adding one has to say so.
    effectPlan: context.effectPlan ?? devEffectPlan(issued.scope.bounds),
    // Null unless the operator PINNED a price table: a model call refuses
    // without one, and the digest binds the exact table every price came from.
    priceTableDigest: context.priceTableDigest ?? null, resourceBounds: issued.scope.bounds,
    surfaceCap: issued.scope.bounds, exposureInputs: Object.freeze([]),
  };
}

/**
 * @file src/operation-bundles/observe.ts
 * @description A NARROW, READ-ONLY observation of one operation bundle's applied
 * state, keyed by the SAME bundle manifest digest `product invoke` reports on a
 * hand-off. It composes the existing durable readers — the operation inventory,
 * the operation key, and the authenticated run record — so an out-of-core
 * coordinator can learn whether the EXACT bundle it handed to the operator was
 * applied, and with what per-mutation outcomes, WITHOUT inferring "applied" from
 * the mere presence of like-named pages (which pre-existing or foreign identical
 * state would satisfy).
 *
 * It is deliberately read-only and authenticated: `readOperationRun` verifies the
 * parsed record against the full run binding (run id + bundle id + manifest digest
 * + key epoch), so a tampered or foreign run refuses rather than reporting a
 * false "applied".
 */

import { scanOperationInventory } from "./capacity.js";
import { resolveTarget } from "./bundle-target.js";
import { readOperationKey } from "./key-epoch.js";
import { readOperationRun } from "./run-store.js";
import { operationRunPredecessor } from "./run-integrity.js";
import { operationNeverStarted } from "./never-started.js";
import { readPageDigest, type LeafDigest } from "./adapters/shared.js";
import type { OperationRunBinding, OperationRunState, MutationOutcomeStatus, OperationRunPredecessor } from "./run-types.js";
import type { OperationMutation, PageOperationMutation } from "./types.js";

/** The only two run states in which the bundle's authoritative mutations landed. */
const APPLIED_TERMINAL_STATES: ReadonlySet<OperationRunState> = new Set(["succeeded", "succeeded-with-warnings"]);

/** The mutation-outcome statuses whose target is a durably-applied output identity. */
const APPLIED_MUTATION_STATUSES: ReadonlySet<MutationOutcomeStatus> = new Set(["applied", "skipped-idempotent"]);

/** One mutation's durable outcome plus the authenticated entity/artifact identity it targeted. */
export interface OperationBundleMutationV1 {
  readonly mutationId: string;
  readonly status: MutationOutcomeStatus;
  /** The manifest mutation's canonical target identity (an entity/artifact ref), not an opaque id. */
  readonly target: string;
}

/** Current bytes sampled after receipt verification, not proof of an effect.
 * A later writer can change them again; historical settlement stays independent. */
export interface OperationPageObservationV1 {
  readonly mutationId: string;
  readonly target: PageOperationMutation["target"];
  readonly precondition: PageOperationMutation["precondition"];
  readonly postcondition: PageOperationMutation["postcondition"];
  readonly current: LeafDigest;
}

/** The narrow observation of a bundle's applied state, or why it could not be read. */
export type OperationBundleObservationV1 =
  | {
      readonly status: "observed";
      readonly runState: OperationRunState;
      readonly binding: OperationRunBinding;
      readonly predecessor: OperationRunPredecessor;
      /** Conservative: true unless the complete run proves never-startedness.
       * True does not prove a mutation occurred; use authenticated outcomes. */
      readonly applicationStarted: boolean;
      readonly pages: readonly OperationPageObservationV1[];
      /** True iff `runState` is an applied terminal (`succeeded`/`succeeded-with-warnings`). */
      readonly applied: boolean;
      readonly mutations: readonly OperationBundleMutationV1[];
      /**
       * The DISTINCT canonical target identities of the applied / idempotently-settled
       * mutations — the bundle's authenticated output identities, projected from the
       * manifest the run's digest binds (never opaque mutation ids or unrelated evidence).
       */
      readonly appliedTargets: readonly string[];
    }
  | { readonly status: "absent" }
  | { readonly status: "unavailable"; readonly detail: string };

/**
 * The canonical, human-recoverable identity of ONE manifest mutation's target — an
 * entity page path, an artifact ref, a relation, etc. TOTAL over the mutation union
 * so a new mutation kind does not silently produce an empty or ambiguous identity.
 */
function canonicalMutationTarget(mutation: OperationMutation): string {
  switch (mutation.kind) {
    case "source-retain": return `source:${mutation.target.digest}`;
    case "page": return mutation.target.kind === "entity"
      ? `page:${mutation.target.entityType}/${mutation.target.slug}`
      : `page-raw:${mutation.target.directory}/${mutation.target.slug}`;
    case "relation": return `relation:${mutation.target.relationType}:${mutation.target.from}->${mutation.target.to}`;
    case "lifecycle-transition": return `lifecycle:${mutation.target.entityType}/${mutation.target.slug}`;
    case "artifact": return `artifact:${mutation.target.artifactType}/${mutation.target.logicalId}`;
    case "catalog-record": return `catalog:${mutation.target.logicalRecordId}`;
    case "projection": return `projection:${mutation.target.recipeId}/${mutation.target.output}`;
  }
}

/**
 * Observe the operation bundle identified by `bundleManifestDigest` (the exact
 * digest `product invoke` hands off): resolve it to its run binding, read the
 * AUTHENTICATED run record, and project its state + per-mutation outcomes. An
 * unknown digest is `absent`; an unreadable key/record is `unavailable`.
 * @param root - Absolute project root.
 * @param bundleManifestDigest - The bundle's manifest digest (from an invoke hand-off).
 */
export async function observeOperationBundle(
  root: string, bundleManifestDigest: string,
): Promise<OperationBundleObservationV1> {
  try { return await observeReadableBundle(root, bundleManifestDigest); }
  catch { return { status: "unavailable", detail: "operation observation unavailable" }; }
}

/** Preserve inventory faults as uncertainty rather than declaring an absent effect. */
async function observeReadableBundle(root: string, bundleManifestDigest: string): Promise<OperationBundleObservationV1> {
  const inventory = await scanOperationInventory(root);
  if (inventory.problems.length) return { status: "unavailable", detail: "operation inventory unavailable" };
  const resolved = resolveTarget(inventory, bundleManifestDigest);
  if (resolved === null) return { status: "absent" };
  const key = await readOperationKey(root);
  if (key.status !== "ok") return { status: "unavailable", detail: `operation key ${key.status}` };
  const binding: OperationRunBinding = {
    runId: resolved.runId, bundleId: resolved.bundleId, manifestDigest: resolved.manifestDigest,
    workspaceId: resolved.workspaceId, keyEpochId: key.keyEpochId,
  };
  const read = await readOperationRun(root, binding);
  if (read.status === "absent") return { status: "absent" };
  if (read.status !== "ok") return { status: "unavailable", detail: read.detail ?? read.status };
  // Join each durable outcome to its manifest mutation's target (both keyed by the
  // same mutation id, both covered by the run's authenticated manifest digest).
  // PROJECTION mutations settle in their OWN outcome list, so both are folded in —
  // otherwise a rendered projection target would be silently dropped.
  const targetById = new Map(resolved.manifest.mutations.map((mutation) => [String(mutation.mutationId), canonicalMutationTarget(mutation)]));
  const outcomes = [...read.run.mutationOutcomes, ...read.run.projectionOutcomes];
  const mutations = outcomes.map((outcome) => ({
    mutationId: String(outcome.mutationId), status: outcome.status,
    target: targetById.get(String(outcome.mutationId)) ?? `mutation:${String(outcome.mutationId)}`,
  }));
  const appliedTargets = [...new Set(mutations.filter((mutation) => APPLIED_MUTATION_STATUSES.has(mutation.status)).map((mutation) => mutation.target))];
  const pages = await observePages(root, resolved.manifest.mutations);
  return { status: "observed", runState: read.run.state, applied: APPLIED_TERMINAL_STATES.has(read.run.state), mutations, appliedTargets,
    binding, predecessor: operationRunPredecessor(read.run),
    applicationStarted: !operationNeverStarted(read.run), pages };
}

/** Rehash actual confined page bytes; declarations remain the authenticated manifest's. */
async function observePages(root: string, mutations: readonly OperationMutation[]): Promise<OperationPageObservationV1[]> {
  return Promise.all(mutations.filter((mutation): mutation is PageOperationMutation => mutation.kind === "page")
    .map(async mutation => ({ mutationId: mutation.mutationId, target: mutation.target,
      precondition: mutation.precondition, postcondition: mutation.postcondition, current: await readPageDigest(root, mutation) })));
}

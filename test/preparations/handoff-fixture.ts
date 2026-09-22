/**
 * @file test/preparations/handoff-fixture.ts
 * @description Shared harness for the Wave O4 Task 8 handoff suites. It stages a
 * real durable preparation, drives its run to `handoff-ready`, and assembles a
 * complete, self-contained handoff request: one host-authored page target whose
 * payload bytes actually hash to their content address, an authentic accepted
 * reconciliation over a normalized proposal, a clean completeness record, and the
 * settled Milestone A bundle authorities. Nothing here fabricates durable run
 * state; every obligation is host-authored exactly as the intent compiler demands.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect } from "vitest";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import { readOperationKey } from "../../src/operation-bundles/key-epoch.js";
import { readOperationRun } from "../../src/operation-bundles/run-store.js";
import { stageOperationBundleLocked } from "../../src/operation-bundles/stage.js";
import { acquireMutationLockBlocking } from "../../src/operation-bundles/lock-gate.js";
import { assertBundleId, assertOperationRunId } from "../../src/operation-bundles/ids.js";
import { releaseLock } from "../../src/utils/lock.js";
import type { OperationRun } from "../../src/operation-bundles/run-types.js";
import type { OperationRunId } from "../../src/operation-bundles/ids.js";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { readPreparationKey } from "../../src/preparations/key-epoch.js";
import { preparationManifestDigest } from "../../src/preparations/manifest-parse.js";
import { readPreparationManifest } from "../../src/preparations/manifest-store.js";
import { preparationRunPredecessor } from "../../src/preparations/run-integrity.js";
import { appendPreparationTransitionLocked, handoffStartBinding, readPreparationRun } from "../../src/preparations/run-store.js";
import { stagePreparationLocked } from "../../src/preparations/stage.js";
import { createOperationIntentCompilerV1, type HostMutationTargetV1 } from "../../src/preparations/intent-compiler.js";
import { normalizeProviderProposals } from "../../src/preparations/proposals.js";
import { decideReconciliation } from "../../src/preparations/reconciliation.js";
import { deriveCompleteness } from "../../src/preparations/completeness.js";
import { buildHandoffBundle } from "../../src/preparations/handoff-bundle.js";
import type { PreparationHandoffRequestV1, PreparationHandoffResultV1 } from "../../src/preparations/handoff.js";
import type { PreparationHandoffObligationsV1 } from "../../src/preparations/service-handoff.js";
import type { HandoffBundleAuthoritiesV1 } from "../../src/preparations/handoff-bundle.js";
import type { PreparationRunBinding } from "../../src/preparations/run-types.js";
import type { PreparationEvidenceRef } from "../../src/operation-bundles/types.js";
import { fixturePlan, stageRequest } from "./store-fixture.js";
import { adapters, ATTEMPT, contract, evidence, identitySetRef, PROVIDER_PIN } from "./task7-fixture.js";

const ACTOR = { id: "operator", surface: "cli" } as const;
const HANDOFF_AT = "2026-07-24T00:00:00.000Z";

/** Deterministic handoff crash seams: before bundle creation, and after it. */
export const CRASH_BEFORE_STAGE = { afterHandoffStarted: async () => { throw new Error("crash"); } };
export const CRASH_AFTER_STAGE = { afterStage: async () => { throw new Error("crash"); } };

/** Corrupt one Milestone A run leaf so its bundle demands recovery. */
export async function tamperOperationRun(dir: string, workspaceId: string, runId: OperationRunId): Promise<void> {
  const file = operationPaths(dir, workspaceId).runFile(runId);
  const record = JSON.parse(await readFile(file, "utf8"));
  record.integrity = `${record.integrity.slice(0, -1)}${record.integrity.endsWith("0") ? "1" : "0"}`;
  await writeFile(file, JSON.stringify(record), "utf8");
}

/** Assert the durable run state for a binding. */
export async function expectRunState(dir: string, binding: PreparationRunBinding, state: string): Promise<void> {
  const run = await readPreparationRun(dir, binding);
  expect(run.status === "ok" && run.run.state).toBe(state);
}

/** Content-address one deterministic page payload for a slug. */
function pagePayload(slug: string): { bytes: Buffer; hex: string } {
  const bytes = canonicalBytes({ page: slug });
  return { bytes, hex: createHash("sha256").update(bytes).digest("hex") };
}

/** One host-authored page target whose payloadRef is the real content address. */
function pageTarget(slug: string): HostMutationTargetV1 {
  const { bytes, hex } = pagePayload(slug);
  return {
    logicalIdentity: `entity:person:${slug}`,
    draft: {
      kind: "page", operation: "create", target: { kind: "entity", entityType: "person", slug },
      payloadRef: hex, precondition: { kind: "absent" }, postcondition: { digest: `sha256:${hex}`, byteCount: bytes.byteLength },
    },
  };
}

/** The normalized proposal, accepted reconciliation, and clean completeness set. */
function obligations(slug: string) {
  const proposals = normalizeProviderProposals({
    contract, attemptId: ATTEMPT, providerPinDigest: PROVIDER_PIN, sourceEvidenceRefs: [evidence],
    drafts: [{ proposalKind: "entity-fact", targetLogicalIdentity: `entity:person:${slug}`, proposedValue: { born: 1815 } }],
  });
  const reconciliations = [decideReconciliation({
    reconciliationId: "accept-facts", contract, proposals, proposalIds: proposals.map((p) => p.proposalId),
    decision: "accept", reasonCodes: ["duplicate-entity"], evidenceRefs: [evidence],
  })];
  const completeness = deriveCompleteness({
    scopeId: "compile", classes: [{
      classId: "entity-facts", disposition: "required", identitySetRef,
      identitySets: sets(slug),
    }],
  }).record;
  return { proposals, reconciliations, completeness };
}

/**
 * The complete Milestone A materializer result a runner journey hands off — one
 * page TARGET with its content-addressed payload, an entity-fact PROPOSAL, its
 * accept RECONCILIATION, an empty SELECTION set, and the required COMPLETENESS —
 * so a journey can prove reconciliation and a full obligation, not just a target.
 * Reuses the same obligation builders the handoff-service suites do.
 */
export function fullMaterialization(slug = "ada"): { result: Record<string, unknown>; payloads: Map<string, Buffer> } {
  const { bytes, hex } = pagePayload(slug);
  const { proposals, reconciliations, completeness } = obligations(slug);
  return {
    result: {
      targets: [pageTarget(slug)], proposals, reconciliations, selections: [], completeness,
      authorityInputs: [], authorityBounds: [],
      operationRun: { declaredCompensatorIndexes: [], controlTransitionAllowance: 1 },
      payloadRefs: [{ role: "proposal-payload", digest: hex, byteCount: bytes.byteLength, mediaType: "application/json" }],
    },
    payloads: new Map([[hex, bytes]]),
  };
}

/** One identity-set record over the eleven categories covering exactly the slug. */
function sets(slug: string): Record<string, string[]> {
  return {
    planned: [slug], eligible: [slug], attempted: [slug], completed: [slug], included: [slug],
    skipped: [], unavailable: [], failed: [], cancelled: [], overflow: [], nonConverged: [],
  };
}

/** The settled, host-authored Milestone A bundle authorities. */
function handoffAuthorities(): HandoffBundleAuthoritiesV1 {
  return {
    grantDigest: parseSha256Digest(`sha256:${"b".repeat(64)}`), inputs: [], bounds: [],
    operationRun: { actor: { id: "operator", surface: "cli", grants: [] }, declaredCompensatorIndexes: [], controlTransitionAllowance: 8 },
  };
}

/**
 * Authorities whose genesis-run authority (control budget and compensation
 * topology) diverges from the fixture default while the compiled manifest is
 * byte-identical — the exact shape a pre-stage-crash resume must refuse.
 */
export function divergentGenesisAuthorities(): HandoffBundleAuthoritiesV1 {
  return {
    ...handoffAuthorities(),
    operationRun: { actor: { id: "operator", surface: "cli", grants: [] }, declaredCompensatorIndexes: [0], controlTransitionAllowance: 16 },
  };
}

/**
 * Directly stage the reserved bundle/run of an in-flight (`handoff-started`) run
 * with a DIVERGENT genesis authority under the SAME manifest — the exact state a
 * pre-stage crash plus an out-of-band create leaves for the recovery gate to find.
 * The manifest digest is invariant to the genesis authority, so this passes the
 * recovery gate's manifest check; only the genesis-authority digest can catch it.
 */
export async function stageDivergentReservedGenesis(root: string, binding: PreparationRunBinding, slug = "ada"): Promise<void> {
  const read = await readPreparationRun(root, binding);
  if (read.status !== "ok") throw new Error(`run ${read.status}`);
  const start = handoffStartBinding(read.run);
  const startedAt = read.run.transitions.find((transition) => transition.type === "handoff-started")?.at;
  if (start === undefined || startedAt === undefined) throw new Error("no handoff-started record");
  const manifest = await readPreparationManifest(root, binding.workspaceId, binding.preparationId);
  if (manifest.status !== "ok") throw new Error(`manifest ${manifest.status}`);
  const { proposals, reconciliations, completeness } = obligations(slug);
  const { bytes, hex } = pagePayload(slug);
  const bundle = buildHandoffBundle({
    manifest: manifest.manifest, reservedBundleId: assertBundleId(start.reservedBundleId),
    compilation: { adapters, contract, proposals, selections: [], targets: [pageTarget(slug)], reconciliations, completeness },
    authorities: divergentGenesisAuthorities(), preparationEvidence: [], payloads: new Map([[hex, bytes]]),
    intentCompiler: createOperationIntentCompilerV1(), handoffId: start.handoffId, preHandoffTransitionHash: start.preHandoffTransitionHash,
  });
  await acquireMutationLockBlocking(root, "handoff");
  try {
    await stageOperationBundleLocked(root, {
      draft: bundle.draft, payloads: bundle.payloads, clock: { now: () => new Date(startedAt) },
      reservedIds: { bundleId: assertBundleId(start.reservedBundleId), runId: assertOperationRunId(start.reservedOperationRunId) },
    });
  } finally {
    await releaseLock(root);
  }
}

/** Read the genesis operation run a completed handoff durably created. */
export async function readCreatedGenesisRun(
  root: string, binding: PreparationRunBinding, result: PreparationHandoffResultV1,
): Promise<OperationRun> {
  const key = await readOperationKey(root);
  if (key.status !== "ok") throw new Error("no operation key");
  const run = await readOperationRun(root, {
    runId: result.operationRunId, bundleId: result.bundleId, manifestDigest: result.bundleManifestDigest,
    workspaceId: binding.workspaceId, keyEpochId: key.keyEpochId,
  });
  if (run.status !== "ok") throw new Error(`created run ${run.status}`);
  return run.run;
}

/** Stage a preparation and drive its run to the `handoff-ready` state. */
export async function stageReadyPreparation(root: string): Promise<PreparationRunBinding> {
  const staged = await stagePreparationLocked(root, stageRequest(fixturePlan()));
  if (staged.status !== "staged") throw new Error(`not staged: ${staged.status}`);
  const key = await readPreparationKey(root);
  if (key.status !== "ok") throw new Error("no preparation key");
  const binding: PreparationRunBinding = {
    runId: staged.manifest.runId, preparationId: staged.manifest.preparationId, workspaceId: staged.manifest.workspaceId,
    manifestDigest: preparationManifestDigest(staged.manifest), keyEpochId: key.keyEpochId,
  };
  await drive(root, binding, "phase-started", "running", { kind: "phase", phaseInstanceId: `phi_${"a".repeat(64)}`, phaseState: "running" }, "2026-07-23T00:01:00.000Z");
  await drive(root, binding, "handoff-ready", "handoff-ready", { kind: "none" }, "2026-07-23T00:02:00.000Z");
  return binding;
}

/** Append one driving transition using the current authenticated predecessor. */
async function drive(root: string, binding: PreparationRunBinding, type: string, stateAfter: string, payload: unknown, at: string): Promise<void> {
  const read = await readPreparationRun(root, binding);
  if (read.status !== "ok") throw new Error(`run ${read.status}`);
  await appendPreparationTransitionLocked(root, binding, preparationRunPredecessor(read.run), {
    type: type as never, stateAfter: stateAfter as never, actor: ACTOR, at, payload: payload as never,
  });
}

/** Build one complete handoff request for a staged, ready preparation. */
/**
 * One preparation evidence ref the bundle actually records.
 *
 * THE ARRAY WAS EMPTY IN EVERY HANDOFF FIXTURE, and that made a whole root of
 * the obligation set unwitnessABLE rather than merely uncovered: reverting its
 * deep capture left every suite green because there was nothing to alias. A
 * missing root looks exactly like a root with nothing wrong.
 *
 * It carries the shape the manifest parser validates — type, provenance, digest,
 * byte count — and it is REACHED: the digest appears in the staged
 * `bundles/<id>/manifest.json` on disk, which is what makes an assertion against
 * it evidence rather than a fixture agreeing with itself. `payloadRef` is
 * omitted deliberately; it is optional, and pointing it at a payload this
 * fixture does not stage would make the ref fail for a reason unrelated to what
 * it is here to witness.
 */
function handoffEvidenceRef(): PreparationEvidenceRef {
  return {
    type: "preparation-output", provenance: "handoff-fixture",
    digest: `sha256:${"7".repeat(64)}` as PreparationEvidenceRef["digest"], byteCount: 3,
  };
}

export function handoffRequest(binding: PreparationRunBinding, slug = "ada", overrides: Partial<PreparationHandoffRequestV1> = {}): PreparationHandoffRequestV1 {
  const { proposals, reconciliations, completeness } = obligations(slug);
  const { bytes, hex } = pagePayload(slug);
  return {
    binding,
    compilation: { adapters, contract, proposals, selections: [], targets: [pageTarget(slug)], reconciliations, completeness },
    authorities: handoffAuthorities(), preparationEvidence: [handoffEvidenceRef()],
    payloads: new Map([[hex, bytes]]),
    actor: ACTOR, at: HANDOFF_AT, ...overrides,
  };
}

/**
 * The SERVICE-shaped obligation set for a staged, ready preparation.
 *
 * DERIVED FROM {@link handoffRequest} rather than rebuilt beside it: the service
 * request is the substrate request minus the four fields the host supplies
 * (binding, actor, timestamp, test faults), so taking it by subtraction is what
 * keeps the two surfaces provably compiling the same bundle. A second builder
 * would let the service suite pass over material the substrate suite never sees.
 */
export function handoffObligations(
  binding: PreparationRunBinding, slug = "ada",
): PreparationHandoffObligationsV1 {
  const {
    binding: _binding, actor: _actor, at: _at, faultsForTest: _faults, ...obligationSet
  } = handoffRequest(binding, slug);
  return obligationSet;
}

/**
 * The same obligation set with its reconciliation left NEEDS-OPERATOR and no
 * settlement — a compilation the intent compiler refuses `needs-operator-pending`.
 *
 * It is the observable shape of a gate rejection reaching the compiler: an
 * unsettled operator obligation and a rejected gate proof BOTH surface as that
 * one code, through `assertSettled`. Using the unsettled form needs no gate
 * wiring and reproduces the same refusal, so a resume that compiles at all fails
 * with it — which is exactly what makes it a discriminating probe for "the resume
 * did not consult the compiler".
 */
export function handoffObligationsUncompilable(
  binding: PreparationRunBinding, slug = "ada",
): PreparationHandoffObligationsV1 {
  const base = handoffObligations(binding, slug);
  const { proposals } = obligations(slug);
  return {
    ...base,
    compilation: {
      ...base.compilation,
      reconciliations: [decideReconciliation({
        reconciliationId: "escalate", contract, proposals,
        proposalIds: proposals.map((proposal) => proposal.proposalId), decision: "needs-operator",
        reasonCodes: ["duplicate-entity"], evidenceRefs: [evidence],
      })],
    },
  };
}

/** One host-authored page target carrying a payload of an exact byte count. */
function sizedPageTarget(slug: string, bytes: Buffer, hex: string): HostMutationTargetV1 {
  return {
    logicalIdentity: `entity:person:${slug}`,
    draft: {
      kind: "page", operation: "create", target: { kind: "entity", entityType: "person", slug },
      payloadRef: hex, precondition: { kind: "absent" }, postcondition: { digest: `sha256:${hex}`, byteCount: bytes.byteLength },
    },
  };
}

/** Build a handoff whose single page payload is exactly `byteCount` bytes. */
export function handoffRequestOversize(binding: PreparationRunBinding, byteCount: number): PreparationHandoffRequestV1 {
  const slug = "ada";
  const bytes = Buffer.alloc(byteCount, 1);
  const hex = createHash("sha256").update(bytes).digest("hex");
  const { proposals, reconciliations, completeness } = obligations(slug);
  return {
    binding,
    compilation: { adapters, contract, proposals, selections: [], targets: [sizedPageTarget(slug, bytes, hex)], reconciliations, completeness },
    authorities: handoffAuthorities(), preparationEvidence: [], payloads: new Map([[hex, bytes]]),
    actor: ACTOR, at: HANDOFF_AT,
  };
}

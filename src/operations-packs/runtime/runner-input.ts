/**
 * @file src/operations-packs/runtime/runner-input.ts
 * @description The one place a compiled pack action becomes a complete
 * {@link RunPreparationInputV1} — the capabilities-and-identity-only entry the
 * host orchestration runner drives a staged run from (runner design v3 §4).
 *
 * EVERY CAPABILITY TRACES TO REAL DATA. The materializer, the authority resolver,
 * the policy contract, and the plan-pinned handler contract digest are all built
 * from the compiled action; the per-phase leg is built from the plan's OWN sealed
 * executor and phase bounds; the adapters and clock are the host's. Nothing here
 * is a fixture constant, and nothing imports from `test/`.
 *
 * ONE REGISTRY, MANY LEGS. The executable registry is constructed once per run
 * and shared by every phase's leg: `resolve(ref)` cannot select a phase, so the
 * registry dispatches on the invocation's `phaseInstanceId` instead, and a
 * per-phase registry would be a second index that could disagree with the first.
 *
 * THE LEG CEILINGS ARE THE TIGHTER OF TWO AUTHORITIES. `hostHandlerLegRunner`
 * fails closed when the caller's declared limits exceed EITHER the sealed phase
 * bounds or the registered descriptor's, and the compiler legitimately grants a
 * phase a multi-attempt wall-time envelope larger than the descriptor's
 * per-invocation ceiling — so each limit is the minimum of the two rather than
 * whichever one happened to be smaller in a fixture.
 *
 * A PROVIDER PHASE NEEDS A HOST TO INVOKE IT. The compiler lowers provider
 * phases, but installing a provider, holding its grant, and running the sandbox
 * are the HOST's, not the platform's — so the runtime executes one only when the
 * host supplies an invocation capability, and settles the phase `failed` with a
 * fixed code when it does not. That refusal is the honest state of a project
 * whose pack asks for a provider nobody installed; it is not a stub.
 *
 * THE HOST CANNOT WIDEN THE SEAL. A host-supplied request is checked against the
 * phase's OWN sealed executor by `providerLegRunner` — pin, capability, schema,
 * exposure, and effect plan must all bind — so supplying the invocation decides
 * only WHETHER a provider runs, never WHICH one or under what authority. Same
 * min-of-two-authorities shape the leg ceilings below use.
 *
 * A phase with no executor at all remains a documented refusal on the same path.
 */

import type { OperationAdapterMap } from "../../operation-bundles/adapter-registry.js";
import type { OperationPrincipal } from "../../operation-bundles/principal.js";
import { hostHandlerLegRunner } from "../../preparations/attempts/host-handler.js";
import { providerLegRunner, type ProviderInvokeFn, type ProviderLegInputV1 } from "../../preparations/attempts/provider.js";
import { buildSourceEvidenceSpecs } from "./source-evidence.js";
import { buildArtifactEvidenceSpecs } from "./artifact-evidence.js";
import { buildPageEvidenceSpecs } from "./page-evidence.js";
import type { ProviderInputSpecV1 } from "../../capability-providers/runtime/inputs.js";
import type {
  AttemptClockV1, AttemptLegOutcomeV1, AttemptLegRunnerV1, HostHandlerRefV1,
  PreparationHostHandlerRegistryV1,
} from "../../preparations/attempts/types.js";
import type { NormalizedPhaseV1, PhaseExecutorV1 } from "../../preparations/plan-types.js";
import type { PreparationPrincipalV1, PreparationRunBinding } from "../../preparations/run-types.js";
import type { RunPreparationInputV1 } from "../../preparations/runner.js";
import type { CompiledPackActionV1 } from "../compiler-types.js";
import { createHostHandlerRegistry } from "../handlers/registry.js";
import { createPackAuthorityResolver } from "./authority-resolver.js";
import { actionInputFrame, createPackHostHandlerRegistry } from "./host-registry.js";
import { renderTemplate } from "../handlers/render-template.js";

/** The ceiling one rendered provider request may occupy. */
const MAXIMUM_PROVIDER_REQUEST_BYTES = 65_536;
import { createPackMaterializer } from "./materializer.js";
import { packPolicyContractFor } from "./policy-contract.js";

/**
 * The identity a host-driven pack action runs under. It names the RUNTIME rather
 * than an operator, because nothing about the drive is an operator decision: the
 * gate decisions an operator does make are recorded through the gate operation
 * under their own principal.
 */
const PACK_RUNTIME_PRINCIPAL_ID = "pack-runtime";

/** The transport a host embedding the runtime drives through. */
const PACK_RUNTIME_SURFACE = "sdk";

/** The fixed problem code a phase the pack runtime cannot execute settles with. */
const UNSUPPORTED_EXECUTOR_PROBLEM = "pack-executor-unsupported";

/** The sealed executor of a phase whose work a capability provider performs. */
export type ProviderPhaseExecutorV1 = Extract<PhaseExecutorV1, { kind: "provider-capability" }>;

/**
 * What the provider is ASKED, rendered by the platform from the plan's own
 * sealed template and the run's frozen input.
 *
 * THE PLATFORM RENDERS AND THE HOST TRANSPORTS. A host that composed the
 * request itself could ask a different question than the plan an operator
 * approved, and the plan digest would no longer describe the invocation. So the
 * text arrives here already rendered, and the host's only job is delivery.
 */
export interface PackProviderRequestV1 {
  /** The template the plan sealed for this phase. */
  readonly templateRef: string;
  /** The rendered request text. */
  readonly text: string;
}

/**
 * The identity one provider invocation is actually bound to.
 *
 * IT COMES FROM THE RUN, NOT FROM CONSTRUCTION. A host builds its invocation
 * before anything is staged, so a run id or workspace baked in then is a guess —
 * and the real run id does not exist until staging has happened. Grants and
 * authority snapshots bind these values, so a guessed one binds the wrong run,
 * and a guessed root binds the wrong PROJECT.
 */
export interface PackProviderRunContextV1 {
  readonly root: string;
  readonly workspaceId: string;
  readonly preparationRunId: string;
  /** The transport the operator invoked through; authority is read from it. */
  readonly surface: PackInvocationSurfaceV1;
  /**
   * The materialized source-evidence inputs the sealed descriptor names, built
   * by the RUNTIME through the same shared builder the authority resolver uses
   * — a host receives them ready rather than resolving paths itself, so it can
   * neither widen nor skip what the plan sealed. Absent when the phase's
   * executor carries no descriptor.
   */
  readonly sourceEvidence?: PackSourceEvidenceContextV1;
}

/** The built source-evidence inputs one provider invocation must carry. */
export interface PackSourceEvidenceContextV1 {
  readonly specs: readonly ProviderInputSpecV1[];
  /** inputId → relative path; placed in the invocation input under `pathTableKey`. */
  readonly pathTable: Readonly<Record<string, string>>;
  readonly pathTableKey: string;
}

/** The transports a product invocation can arrive on. */
export type PackInvocationSurfaceV1 = "cli" | "sdk" | "mcp";

/**
 * The host's ability to execute provider phases.
 *
 * `legInputFor` returns null for a provider the host cannot serve — an
 * uninstalled pin, a capability with no grant — and that phase then refuses
 * exactly as if no capability had been supplied at all. Returning null is the
 * host declining ONE phase; omitting the capability declines all of them.
 */
export interface PackProviderInvocationV1 {
  legInputFor(
    executor: ProviderPhaseExecutorV1, phase: NormalizedPhaseV1,
    request: PackProviderRequestV1, context: PackProviderRunContextV1,
  ): Promise<ProviderLegInputV1 | null> | ProviderLegInputV1 | null;
  /** The host's invoker; defaults to the real sandboxed provider runtime. */
  readonly invoke?: ProviderInvokeFn;
}

/** What the host supplies to drive one compiled action's staged run. */
export interface PackRunnerContextV1 {
  readonly root: string;
  readonly binding: PreparationRunBinding;
  /** The host's registered Milestone A store adapters (`createOperationRuntime`). */
  readonly adapters: OperationAdapterMap;
  readonly clock: AttemptClockV1;
  /**
   * The transport this drive was invoked through. Provider authority is bound
   * to it, so a host that stamped the wrong one would resolve grants for a
   * surface the operator never used.
   */
  readonly surface?: PackInvocationSurfaceV1;
  /** Absent when the host installs no providers; provider phases then refuse. */
  readonly providerInvocation?: PackProviderInvocationV1;
}

/** A leg that settles its phase `failed` because this runtime cannot execute it. */
function unsupportedLeg(): AttemptLegRunnerV1 {
  return async (): Promise<AttemptLegOutcomeV1> => ({
    phaseState: "failed", pendingEvidence: [], effects: [], invocationCount: 0,
    brokerRequestCount: 0, tokenCount: 0, costMicros: 0, problem: UNSUPPORTED_EXECUTOR_PROBLEM,
  });
}

/** The sealed host-handler ref of one work phase, or null when it has no executor. */
function sealedRefOf(phase: NormalizedPhaseV1 | undefined): HostHandlerRefV1 | null {
  const executor = phase?.executor;
  if (executor === undefined || executor.kind !== "host-handler") return null;
  return {
    handlerId: executor.handlerId, handlerContractVersion: executor.handlerContractVersion,
    handlerContractDigest: executor.handlerContractDigest,
  };
}

/**
 * Build whichever sealed evidence context the executor names — source,
 * artifact, or page evidence (ONE kind per phase; the compiler refuses more).
 * Downstream (tokens, mounts, exposure digest) the three are
 * indistinguishable. A build refusal returns its reason as a string.
 */
async function builtEvidenceContext(
  root: string, executor: { sourceEvidenceDescriptor?: Parameters<typeof buildSourceEvidenceSpecs>[1]; artifactEvidenceDescriptor?: Parameters<typeof buildArtifactEvidenceSpecs>[1]; pageEvidenceDescriptor?: Parameters<typeof buildPageEvidenceSpecs>[1] } & Record<string, unknown>,
  value: Parameters<typeof buildSourceEvidenceSpecs>[2],
): Promise<PackSourceEvidenceContextV1 | undefined | string> {
  const source = executor.sourceEvidenceDescriptor;
  if (source !== undefined) {
    const built = await buildSourceEvidenceSpecs(root, source, value);
    if (built.status !== "ok") return built.reason;
    return { specs: built.built.specs, pathTable: built.built.pathTable, pathTableKey: source.pathTableKey };
  }
  const artifact = executor.artifactEvidenceDescriptor;
  if (artifact !== undefined) {
    const built = await buildArtifactEvidenceSpecs(root, artifact, value);
    if (built.status !== "ok") return built.reason;
    return { specs: built.built.specs, pathTable: built.built.pathTable, pathTableKey: artifact.pathTableKey };
  }
  const page = executor.pageEvidenceDescriptor;
  if (page !== undefined) {
    const built = await buildPageEvidenceSpecs(root, page, value);
    if (built.status !== "ok") return built.reason;
    return { specs: built.built.specs, pathTable: built.built.pathTable, pathTableKey: page.pathTableKey };
  }
  return undefined;
}

/** Build one provider phase's leg, or refuse when the host cannot serve it. */
function providerLegForPhase(
  phase: NormalizedPhaseV1, executor: ProviderPhaseExecutorV1, ctx: PackRunnerContextV1,
  action: CompiledPackActionV1,
): AttemptLegRunnerV1 {
  const capability = ctx.providerInvocation;
  if (capability === undefined) return unsupportedLeg();
  const request = providerRequestFor(executor, action);
  // A phase whose sealed request cannot be rendered is REFUSED rather than sent
  // an empty question: a provider asked nothing would answer about nothing, and
  // the run would record that answer as if it were the extraction.
  if (request === null) return unsupportedLeg();
  // RESOLVED WHEN THE PHASE RUNS, not when the leg is built: binding an
  // invocation to this project may require reading the filesystem, which a
  // synchronous factory cannot do.
  return async (legContext) => {
    // The sealed descriptor's inputs, built HERE so the host receives them
    // ready. A build refusal parks the leg with its reason — running the
    // provider with no sources under a plan that sealed some would answer a
    // different question than the operator approved.
    const evidence = await builtEvidenceContext(ctx.root, executor, action.initialInput.value);
    if (typeof evidence === "string") return failedEvidenceLeg(evidence);
    const sourceEvidence = evidence;
    const legInput = await capability.legInputFor(executor, phase, request, {
      root: ctx.root, workspaceId: ctx.binding.workspaceId,
      preparationRunId: ctx.binding.runId,
      // `sdk` is the historical default for a host that names none; stated here
      // rather than deep in an adapter so a wrong stamp is visible.
      surface: ctx.surface ?? "sdk",
      ...(sourceEvidence === undefined ? {} : { sourceEvidence }),
    });
    if (legInput === null) return unsupportedLeg()(legContext);
    // The request is NOT trusted to describe its own phase: `providerLegRunner`
    // binds it against the sealed executor and refuses a mismatch, so a host
    // returning the wrong provider's request fails closed rather than running it.
    return providerLegRunner(legInput, capability.invoke)(legContext);
  };
}

/** The failed-leg outcome an evidence-build refusal parks with. */
function failedEvidenceLeg(problem: string): AttemptLegOutcomeV1 {
  return {
    phaseState: "failed", pendingEvidence: [], effects: [], invocationCount: 0,
    brokerRequestCount: 0, tokenCount: 0, costMicros: 0, problem,
  };
}

/**
 * Render the request one provider phase is sealed to ask, from the plan's own
 * template and the run's frozen action input. Null when the plan sealed no
 * template, or names one the compiled action does not carry.
 */
function providerRequestFor(
  executor: ProviderPhaseExecutorV1, action: CompiledPackActionV1,
): PackProviderRequestV1 | null {
  const templateRef = executor.requestTemplateRef;
  if (templateRef === undefined) return null;
  const template = action.renderTemplates[templateRef];
  if (template === undefined) return null;
  try {
    const rendered = renderTemplate({
      body: { templateRef, formatId: "markdown", escapingPolicyId: "per-node", inputEvidenceRefs: [] } as never,
      template, frame: actionInputFrame(action), items: [],
      bounds: { maximumItems: 1, maximumOutputBytes: MAXIMUM_PROVIDER_REQUEST_BYTES },
    });
    return { templateRef, text: rendered.output };
  } catch {
    return null;
  }
}

/** Build one phase's leg over the shared executable registry, or refuse it. */
function legForPhase(
  phase: NormalizedPhaseV1 | undefined, registry: PreparationHostHandlerRegistryV1,
  ctx: PackRunnerContextV1, action: CompiledPackActionV1,
): AttemptLegRunnerV1 {
  if (phase?.executor?.kind === "provider-capability") {
    return providerLegForPhase(phase, phase.executor, ctx, action);
  }
  const ref = sealedRefOf(phase);
  if (ref === null || phase === undefined) return unsupportedLeg();
  // The registered descriptor's ceilings are read through the SAME 3A resolver the
  // leg itself will bind against, so the limits declared here can never exceed the
  // ones the leg checks them with.
  const descriptor = createHostHandlerRegistry().resolve(ref).descriptor;
  return hostHandlerLegRunner({
    ref, registry,
    maximumOutputBytes: Math.min(phase.bounds.maximumOutputEvidenceBytes, descriptor.maximumOutputBytes),
    maximumWallTimeMs: Math.min(phase.bounds.maximumTimeMsPerInstance, descriptor.maximumWallTimeMs),
  });
}

/** The operation-bundle principal the handoff stamps its genesis authority from. */
function operationPrincipal(): OperationPrincipal {
  return { id: PACK_RUNTIME_PRINCIPAL_ID, surface: PACK_RUNTIME_SURFACE, grants: [] };
}

/** The preparation principal every durable transition this drive appends records. */
function preparationPrincipal(): PreparationPrincipalV1 {
  return { id: PACK_RUNTIME_PRINCIPAL_ID, surface: PACK_RUNTIME_SURFACE };
}

/**
 * Assemble the complete runner input for one compiled pack action's staged run.
 *
 * @param action - The compiled action: plan, phase bindings, materialization
 *   spec, and sealed initial input.
 * @param ctx - The project root, the durable run binding, the host's Milestone A
 *   adapters, and the host clock.
 * @returns The capabilities-and-identity input `runPreparation` drives from.
 */
export function assembleRunnerInput(
  action: CompiledPackActionV1, ctx: PackRunnerContextV1,
): RunPreparationInputV1 {
  const registry = createPackHostHandlerRegistry(action, {
    manifestDigest: ctx.binding.manifestDigest, runId: ctx.binding.runId,
    principal: PACK_RUNTIME_PRINCIPAL_ID, clock: ctx.clock,
    root: ctx.root, binding: ctx.binding,
  });
  const phases = new Map(action.plan.phases.map((phase) => [phase.logicalPhaseId, phase]));
  return {
    root: ctx.root, binding: ctx.binding,
    materializer: createPackMaterializer(action),
    legFor: (logicalPhaseId: string) => legForPhase(phases.get(logicalPhaseId), registry, ctx, action),
    authorityResolver: createPackAuthorityResolver({ root: ctx.root, binding: ctx.binding }),
    adapters: ctx.adapters,
    policyContract: packPolicyContractFor(action),
    principal: preparationPrincipal(),
    operationPrincipal: operationPrincipal(),
    handlerContractDigest: action.materializationSpec.handlerContractDigest,
    clock: ctx.clock,
  };
}

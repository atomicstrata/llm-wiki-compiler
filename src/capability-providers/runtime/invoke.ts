/**
 * @file src/capability-providers/runtime/invoke.ts
 * @description The only capability-provider invocation entrypoint. It gates
 * custody feasibility before launch, holds the input-exposure digest stable
 * before resolving the effective grant (D6.3), drives the framed protocol over
 * an injected accepted backend (D6.7 — no child_process in src), materializes
 * large broker-response bytes into a guest-read-only region and hands the
 * provider an opaque token (D6.1), composes cancellation with the broker
 * deadline (D6.6), and admits the terminal result from host-observed facts —
 * including the host-priced token and cost usage its own broker meter counted,
 * so a metered phase can commit on measurement instead of parking unmeasured.
 */
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import type { PayloadDescriptorV1, ProviderBackendChannelV1, LaunchSnapshotInputV1, ProviderLaunchDescriptorV1, ProviderBackendV1 } from "./backend-contract.js";
export type { PayloadDescriptorV1, BrokerResponseRegionV1, ProviderBackendChannelV1, LaunchSnapshotInputV1, ProviderLaunchDescriptorV1, ProviderBackendV1 } from "./backend-contract.js";
import { neutralisedProviderText } from "./untrusted-text.js";
import type { AuthorizedProviderPaths } from "../packages/paths.js";
import { resolveEffectiveProviderGrant } from "../authority/grants-resolve.js";
import type {
  EffectiveProviderGrantRequestV1, EffectiveProviderGrantV1,
} from "../authority/types.js";
import {
  createHostBrokerDispatcher, dispatchHostBrokerRequestForHost,
  type HostBrokerAdaptersV1, type HostBrokerDispatcherV1,
} from "../brokers/dispatch.js";
import type { HostBrokerDispatchV1 } from "../brokers/types.js";
import type { ExternalEffectReceiptV1 } from "../brokers/receipts.js";
import { parseSha256Digest } from "../ids.js";
import type { InvocationIdV1 } from "../types.js";
import type { ProviderProblemCodeV1 } from "../problems.js";
import { createInvocationCancellation, type InvocationCancellationV1 } from "./cancellation.js";
import { assessCustodyFeasibility, type CustodyBudgetV1, type DeclaredCustodyValidatorV1 } from "./custody.js";
import { buildVerifiedLaunchSnapshot, type VerifiedLaunchSnapshotV1 } from "./launch-snapshot.js";
import { createBrokerResponseRegion, type BrokerResponseRegionHandleV1 } from "./broker-response-region.js";
import { createEvidenceStore, type EvidenceStoreV1 } from "./evidence-store.js";
import { materializeProviderInputs, type MaterializedProviderInputsV1, type ProviderInputSpecV1 } from "./inputs.js";
import {
  MeteredInvocationFaultV1, projectMeteredFaultUsage, projectObservedUsage,
} from "./observed-usage.js";
import { createStreamingCustodian } from "./custodian.js";
import { createFrameDecoder, ProviderFramingError, type FrameDecoderV1 } from "./framing.js";
import {
  ProviderProtocolError, ProviderProtocolSessionV1, type InitializeFrameInputV1,
} from "./protocol.js";
import {
  admitProviderResult, type AdmittedProviderResultV1, type CustodyOutcomeV1,
  type DeclaredArtifactOutputV1, type ProviderObservedUsageV1,
} from "./result-admission.js";
import type {
  ProviderEventV1, RuntimeExpectedIdentityV1, RuntimeInputTokenDescriptorV1,
  RuntimeJsonObjectV1, RuntimeJsonValueV1,
} from "./types.js";







/** Complete invocation request; all identity and authority is host-derived. */
export interface ProviderInvocationRequestV1 {
  readonly paths: AuthorizedProviderPaths;
  readonly invocationId: InvocationIdV1;
  readonly nonce: string;
  readonly authorityRequest: EffectiveProviderGrantRequestV1;
  readonly expectedIdentity: RuntimeExpectedIdentityV1;
  readonly launch: LaunchSnapshotInputV1;
  readonly inputSpecs: readonly ProviderInputSpecV1[];
  readonly input: RuntimeJsonValueV1;
  readonly operationContext: RuntimeJsonObjectV1;
  readonly declaredOutputs: readonly DeclaredArtifactOutputV1[];
  readonly custodyValidators: readonly DeclaredCustodyValidatorV1[];
  /**
   * Secret byte-patterns the custodian scans every accepted output against, as
   * defense-in-depth behind the broker-side credential-reflection scan. The
   * caller supplies the raw credential bytes it configured; the custodian
   * expands them to the supported encoded forms itself. Credentials never enter
   * the provider, so this corpus is host-owned and never provider-derived.
   */
  readonly secretCorpus?: readonly Uint8Array[];
  readonly brokers: HostBrokerAdaptersV1;
  readonly hostSignal?: AbortSignal;
}

/** Injected host collaborators for one invocation. */
export interface ProviderInvocationHostV1 {
  readonly backend: ProviderBackendV1;
}

/**
 * Closed invocation outcome; a failure names one stable problem code.
 * `cleanupFailures`, when present, carries scratch/backend teardown errors that
 * are visible and retryable but never change the outcome (F4).
 *
 * A failure carries `usage` exactly when it happened AFTER the broker dispatcher
 * existed, so spend the host already observed survives the failure instead of
 * being discarded — the case that matters most, since a failed attempt is the
 * one that may be retried. A failure raised before the dispatcher was built has
 * no meter to read and omits the field, which downstream reads as unobserved.
 */
export type ProviderInvocationResultV1 =
  | { readonly kind: "completed"; readonly admitted: AdmittedProviderResultV1; readonly cleanupFailures?: readonly string[] }
  | {
      readonly kind: "failed";
      readonly problem: ProviderProblemCodeV1;
      readonly detail: string;
      readonly usage?: ProviderObservedUsageV1;
      readonly cleanupFailures?: readonly string[];
    };

interface InvocationContextV1 {
  readonly request: ProviderInvocationRequestV1;
  readonly host: ProviderInvocationHostV1;
  readonly grant: EffectiveProviderGrantV1;
  readonly dispatcher: HostBrokerDispatcherV1;
  readonly channel: ProviderBackendChannelV1;
  readonly cancellation: InvocationCancellationV1;
  readonly region: BrokerResponseRegionHandleV1;
  readonly evidence: EvidenceStoreV1;
  /** One custody scan allowance shared by broker-response bytes and outputs (F3). */
  readonly custodyBudget: { scanned: number };
  readonly inputTokens: readonly RuntimeInputTokenDescriptorV1[];
  readonly receipts: ExternalEffectReceiptV1[];
}

interface ResolvedAuthorityV1 {
  readonly inputs: MaterializedProviderInputsV1;
  readonly authorityRequest: EffectiveProviderGrantRequestV1;
  readonly grant: EffectiveProviderGrantV1;
}
type AuthorityOutcomeV1 =
  | { readonly kind: "ok"; readonly value: ResolvedAuthorityV1 }
  | { readonly kind: "failed"; readonly result: ProviderInvocationResultV1 };

/** Run one bounded, brokered, sandboxed capability-provider invocation. */
export async function invokeCapabilityProvider(
  request: ProviderInvocationRequestV1, host: ProviderInvocationHostV1,
): Promise<ProviderInvocationResultV1> {
  const disposers: Array<() => Promise<void>> = [];
  let outcome: { result: ProviderInvocationResultV1 } | { error: unknown };
  try {
    outcome = { result: await prepareAndRun(request, host, disposers) };
  } catch (error) {
    outcome = { error };
  }
  const cleanupFailures = await runDisposers(disposers);
  if ("error" in outcome) throw outcome.error;
  return cleanupFailures.length > 0 ? { ...outcome.result, cleanupFailures } : outcome.result;
}

/** Run every disposer, returning cleanup failures instead of swallowing them (F4). */
async function runDisposers(disposers: Array<() => Promise<void>>): Promise<string[]> {
  const failures: string[] = [];
  for (const dispose of disposers.reverse()) {
    try {
      await dispose();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "provider cleanup failed");
    }
  }
  return failures;
}

/** Acquire authority, gate custody against the resolved grant, launch, and run. */
async function prepareAndRun(
  request: ProviderInvocationRequestV1, host: ProviderInvocationHostV1,
  disposers: Array<() => Promise<void>>,
): Promise<ProviderInvocationResultV1> {
  const authority = await resolveAuthority(request, disposers);
  if (authority.kind === "failed") return authority.result;
  const feasibility = assessCustodyFeasibility(request.custodyValidators, custodyBudget(authority.value.grant));
  if (feasibility.kind === "infeasible") {
    return failed("provider-resource-exhausted", `custody infeasible before launch: ${feasibility.detail}`);
  }
  const snapshot = await buildLaunchSnapshot(request);
  if (snapshot.kind === "failed") return snapshot.result;
  disposers.push(snapshot.value.dispose);
  const region = await createBrokerResponseRegion(request.launch.launchParentDir);
  disposers.push(region.dispose);
  // The accepted-evidence store is intentionally NOT registered for disposal:
  // its retained bytes are the durable output the caller owns and must outlive
  // this invocation's scratch teardown (F1). Its directory is provisioned lazily
  // on first retain so provisioning faults fail closed inside the custody seam.
  const evidence = createEvidenceStore(request.launch.launchParentDir);
  const cancellation = createInvocationCancellation(authority.value.grant.bounds.wallTimeMs, request.hostSignal);
  const dispatcher = await createHostBrokerDispatcher({
    paths: request.paths, authorityRequest: authority.value.authorityRequest,
    invocationId: request.invocationId, brokers: request.brokers, deadlineSignal: cancellation.signal,
  });
  // Everything past this point runs with a LIVE meter, so it is wrapped: any
  // exception escaping the backend launch, a channel send/receive, the broker
  // dispatcher, the response region, or terminal custody must not carry the
  // observed spend away with it (see runWithLiveMeter).
  return await runWithLiveMeter(dispatcher, async () => {
    const channel = await host.backend.launch(launchDescriptor(request, authority.value, snapshot.value, region));
    disposers.push(() => channel.terminate());
    return await runInvocation({
      request, host, grant: authority.value.grant, dispatcher, channel, cancellation, region, evidence,
      custodyBudget: { scanned: 0 }, inputTokens: authority.value.inputs.inputTokens, receipts: [],
    });
  });
}

/**
 * Run one region of the invocation with the broker meter already live, so that
 * NO exception can leave it without the spend the host observed. Only some
 * failures inside this region are typed (protocol/framing) and return a failed
 * result; the rest — a backend that cannot be launched, a channel send or
 * receive that rejects, a dispatcher refusal, a response region that cannot
 * materialize, terminal custody that faults — are ordinary throws and would
 * otherwise unwind straight past the result path, erasing measured spend exactly
 * where a retry may follow.
 *
 * The throw is deliberately preserved rather than converted into a failed
 * result: the executor classifies a thrown leg `recovery-required`, which retry
 * treats as never-retryable, and downgrading it to an ordinary failure would let
 * an unknown-state leg become retryable. Only the measurement is added.
 */
async function runWithLiveMeter(
  dispatcher: HostBrokerDispatcherV1, run: () => Promise<ProviderInvocationResultV1>,
): Promise<ProviderInvocationResultV1> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MeteredInvocationFaultV1) throw error;
    throw new MeteredInvocationFaultV1(error, projectMeteredFaultUsage(dispatcher));
  }
}

/** Materialize inputs first, pin the exposure digest, then resolve the grant (D6.3). */
async function resolveAuthority(
  request: ProviderInvocationRequestV1, disposers: Array<() => Promise<void>>,
): Promise<AuthorityOutcomeV1> {
  let inputs: MaterializedProviderInputsV1;
  try {
    inputs = await materializeProviderInputs(request.launch.launchParentDir, request.inputSpecs);
  } catch (error) {
    return { kind: "failed", result: failed("provider-bounds-invalid", inputDetail(error)) };
  }
  disposers.push(inputs.dispose);
  const authorityRequest = Object.freeze({ ...request.authorityRequest, exposureInputs: inputs.inputs });
  try {
    const grant = await resolveEffectiveProviderGrant(request.paths, authorityRequest);
    if (grant.exposure.inputExposureSetDigest !== inputs.exposureDigest) {
      return { kind: "failed", result: failed("provider-drift", "input exposure drifted before the grant resolved") };
    }
    return { kind: "ok", value: { inputs, authorityRequest, grant } };
  } catch (error) {
    return { kind: "failed", result: failed("provider-grant-missing", inputDetail(error)) };
  }
}

function launchDescriptor(
  request: ProviderInvocationRequestV1, authority: ResolvedAuthorityV1,
  snapshot: VerifiedLaunchSnapshotV1, region: BrokerResponseRegionHandleV1,
): ProviderLaunchDescriptorV1 {
  return {
    expectedIdentity: request.expectedIdentity, inputTokens: authority.inputs.inputTokens,
    launchRoot: snapshot.launchRoot, entrypointRelativePath: snapshot.entrypointRelativePath,
    brokerResponseRegionMount: region.sandboxMountRelative, wallTimeMs: authority.grant.bounds.wallTimeMs,
  };
}

function inputDetail(error: unknown): string {
  return error instanceof Error ? error.message : "provider authority is unavailable";
}

/** Derive the effective custody budget from the resolved grant so the pre-launch
 * feasibility gate and the runtime custodian enforce the exact same ceilings. */
function custodyBudget(grant: EffectiveProviderGrantV1): CustodyBudgetV1 {
  return {
    scanBytes: grant.bounds.custodyScanBytes, wallTimeMs: grant.bounds.custodyWallTimeMs,
    outputBytes: grant.bounds.outputBytes, outputFiles: grant.bounds.outputFiles,
  };
}

type LaunchSnapshotOutcomeV1 =
  | { readonly kind: "ok"; readonly value: VerifiedLaunchSnapshotV1 }
  | { readonly kind: "failed"; readonly result: ProviderInvocationResultV1 };

/** Build the invocation-private verified launch snapshot, mapping refusal to a typed failure. */
async function buildLaunchSnapshot(request: ProviderInvocationRequestV1): Promise<LaunchSnapshotOutcomeV1> {
  try {
    return { kind: "ok", value: await buildVerifiedLaunchSnapshot({
      sourceTreeReal: request.launch.sourceTreeReal, artifact: request.launch.artifact,
      launchParentDir: request.launch.launchParentDir,
    }) };
  } catch (error) {
    return { kind: "failed", result: failed("provider-package-integrity-invalid",
      `invocation-private launch snapshot failed: ${error instanceof Error ? neutralisedProviderText(error.message, MAX_ERROR_FRAME_DETAIL_BYTES) : "unknown"}`) };
  }
}

async function runInvocation(ctx: InvocationContextV1): Promise<ProviderInvocationResultV1> {
  const session = new ProviderProtocolSessionV1({
    invocationId: ctx.request.invocationId, nonce: ctx.request.nonce,
    expectedIdentity: ctx.request.expectedIdentity,
  });
  await ctx.channel.send(session.buildInitialize(initializeInput(ctx.grant, ctx.request, ctx.inputTokens)));
  try {
    return await driveProtocol(ctx, session);
  } catch (error) {
    if (error instanceof ProviderProtocolError || error instanceof ProviderFramingError) {
      return failedAfterDispatch(ctx, session, "provider-protocol-invalid", error.message);
    }
    throw error;
  }
}

/**
 * The bounded cooperative window after a host cancel before the pump abandons a
 * pending `receive()` and returns — so `channel.terminate()` (a disposer) fires
 * even against a provider that never answers, and the invocation never hangs.
 */
const PROVIDER_CANCEL_GRACE_MS = 250;

/** A sentinel returned when the bounded cancel window elapses on a pending receive. */
const RECEIVE_CANCELLED = Symbol("provider-receive-cancelled");

/** Resolve once the signal aborts, attaching a SINGLE listener for the whole pump. */
function onceAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Race an already-pending receive against the bounded cancel grace window. */
function raceReceiveAgainstGrace(receive: Promise<Buffer | null>): Promise<Buffer | null | typeof RECEIVE_CANCELLED> {
  const grace = new Promise<typeof RECEIVE_CANCELLED>((resolve) => {
    const timer = setTimeout(() => resolve(RECEIVE_CANCELLED), PROVIDER_CANCEL_GRACE_MS);
    timer.unref?.();
  });
  return Promise.race([receive, grace]);
}

/**
 * Receive the next chunk, but never wait forever once the host cancels: if the
 * signal aborts while `receive()` is pending, bound the wait to the cooperative
 * grace window and then return the cancel sentinel so the pump can terminate.
 */
async function receiveOrCancel(ctx: InvocationContextV1, aborted: Promise<void>): Promise<Buffer | null | typeof RECEIVE_CANCELLED> {
  const receive = ctx.channel.receive();
  if (ctx.cancellation.signal.aborted) return raceReceiveAgainstGrace(receive);
  const winner = await Promise.race([receive.then((chunk) => ({ chunk })), aborted.then(() => ({ aborted: true as const }))]);
  return "chunk" in winner ? winner.chunk : raceReceiveAgainstGrace(receive);
}

/** Pump framed provider events to the terminal result, honoring host cancellation. */
async function driveProtocol(
  ctx: InvocationContextV1, session: ProviderProtocolSessionV1,
): Promise<ProviderInvocationResultV1> {
  const decoder = createFrameDecoder();
  const aborted = onceAborted(ctx.cancellation.signal);
  for (;;) {
    if (ctx.cancellation.signal.aborted) return await cancelInvocation(ctx, session);
    const chunk = await receiveOrCancel(ctx, aborted);
    if (chunk === RECEIVE_CANCELLED) return await cancelInvocation(ctx, session);
    if (chunk === null) {
      return session.isTerminal ? await finishTerminal(ctx, session, decoder)
        : failedAfterDispatch(ctx, session, "provider-protocol-invalid", "provider stream closed before a terminal frame");
    }
    const outcome = await ingestChunk(ctx, session, decoder.push(chunk));
    if (outcome) return outcome;
    if (session.isTerminal) return await finishTerminal(ctx, session, decoder);
  }
}

/** Admit the terminal result only when no truncated/trailing frame bytes remain (F4). */
async function finishTerminal(
  ctx: InvocationContextV1, session: ProviderProtocolSessionV1, decoder: FrameDecoderV1,
): Promise<ProviderInvocationResultV1> {
  if (decoder.hasPendingBytes()) {
    return failedAfterDispatch(ctx, session, "provider-protocol-invalid", "trailing bytes followed the terminal result frame");
  }
  return admitTerminal(ctx, session);
}

async function ingestChunk(
  ctx: InvocationContextV1, session: ProviderProtocolSessionV1,
  frames: ReadonlyArray<{ readonly value: unknown }>,
): Promise<ProviderInvocationResultV1 | undefined> {
  for (const frame of frames) {
    const outcome = await handleEvent(ctx, session, session.ingest(frame.value));
    if (outcome) return outcome;
  }
  return undefined;
}

async function handleEvent(
  ctx: InvocationContextV1, session: ProviderProtocolSessionV1, event: ProviderEventV1,
): Promise<ProviderInvocationResultV1 | undefined> {
  switch (event.type) {
    case "initialized":
      await ctx.channel.send(session.buildInvoke(ctx.request.input, ctx.request.operationContext));
      return undefined;
    case "broker-request": return handleBrokerRequest(ctx, session, event);
    // The frame's detail is provider bytes rendered as host text: one printable line, bounded, labelled.
    case "error": return failedAfterDispatch(ctx, session, event.code,
      `provider reported ${event.code} (untrusted detail): ${neutralisedProviderText(event.detail, MAX_ERROR_FRAME_DETAIL_BYTES)}`);
    default: return undefined;
  }
}

async function handleBrokerRequest(
  ctx: InvocationContextV1, session: ProviderProtocolSessionV1,
  event: Extract<ProviderEventV1, { type: "broker-request" }>,
): Promise<ProviderInvocationResultV1 | undefined> {
  const dispatch = await dispatchHostBrokerRequestForHost(ctx.dispatcher, event.request);
  if (dispatch.result.receipt) ctx.receipts.push(dispatch.result.receipt);
  const response = await brokerResponseFrame(ctx, dispatch);
  await ctx.channel.send(session.buildBrokerResponse(event.requestId, response));
  return undefined;
}

/** Build the provider-visible broker-response body, tokenizing large bytes. */
async function brokerResponseFrame(
  ctx: InvocationContextV1, dispatch: HostBrokerDispatchV1,
): Promise<RuntimeJsonObjectV1> {
  const base: Record<string, RuntimeJsonValueV1> = {
    status: dispatch.result.status, output: dispatch.result.output ?? null,
  };
  if (dispatch.visibleBytes.length > 0) {
    // Debit these bytes against the one custody allowance terminal custody
    // resumes from, so broker bodies and outputs cannot each spend it in full (F3).
    ctx.custodyBudget.scanned += dispatch.visibleBytes.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const descriptor = await ctx.region.materialize(dispatch.visibleBytes, "broker-response");
    base.payload = payloadObject(descriptor);
  }
  return Object.freeze(base);
}

function payloadObject(descriptor: PayloadDescriptorV1): RuntimeJsonObjectV1 {
  return Object.freeze({
    token: descriptor.token, digest: descriptor.digest, byteCount: descriptor.byteCount,
    mediaType: descriptor.mediaType, provenanceLabel: descriptor.provenanceLabel,
  });
}

async function admitTerminal(
  ctx: InvocationContextV1, session: ProviderProtocolSessionV1,
): Promise<ProviderInvocationResultV1> {
  const terminal = session.terminalEvent;
  if (!terminal || terminal.type !== "result") {
    return failedAfterDispatch(ctx, session, "provider-protocol-invalid", "no terminal result frame was received");
  }
  if (session.outstandingBrokerCount !== 0) {
    return failedAfterDispatch(ctx, session, "provider-protocol-invalid", "terminal result left a broker request outstanding");
  }
  const custodian = createStreamingCustodian({
    outputRoot: await ctx.channel.outputRoot(), declaredOutputs: ctx.request.declaredOutputs,
    scanBytes: ctx.grant.bounds.custodyScanBytes, wallTimeMs: ctx.grant.bounds.custodyWallTimeMs,
    outputBytes: ctx.grant.bounds.outputBytes, outputFiles: ctx.grant.bounds.outputFiles,
    maxOutputBytesById: perFileOutputMaxima(ctx.request.custodyValidators),
    secrets: ctx.request.secretCorpus ?? [], retainEvidence: ctx.evidence.retain,
    discardEvidence: ctx.evidence.discard, initialScanBytes: ctx.custodyBudget.scanned,
  });
  const custody = await custodian.custody(terminal.result);
  return {
    kind: "completed",
    admitted: admitProviderResult({
      providerResult: terminal.result, custody,
      declaredOutputs: ctx.request.declaredOutputs, receipts: ctx.receipts,
      // Host-observed usage: the protocol session counts every broker request
      // (including read-only HTTPS/model calls) and the invocation's own broker
      // meter carries the host-priced model tokens and cost. A dimension the
      // runtime cannot read stays the explicit "unobserved" sentinel rather than
      // becoming a fabricated zero (RC-B).
      usage: projectObservedUsage(ctx.dispatcher, session.observedBrokerRequestCount),
    }),
  };
}

/**
 * Send the cooperative cancel frame BEST-EFFORT within the bounded grace window.
 * Cooperative cancel is a courtesy; forced termination is the guarantee. A hung
 * or failing `send()` must never block the return, so the invocation always
 * unwinds and its `channel.terminate()` disposer force-terminates the backend on
 * a bound — even against a provider whose `send()` never resolves.
 */
async function sendCancelBestEffort(ctx: InvocationContextV1, session: ProviderProtocolSessionV1): Promise<void> {
  const send = ctx.channel.send(session.buildCancel()).catch(() => {});
  const grace = new Promise<void>((resolve) => { const timer = setTimeout(resolve, PROVIDER_CANCEL_GRACE_MS); timer.unref?.(); });
  await Promise.race([send, grace]);
}

async function cancelInvocation(
  ctx: InvocationContextV1, session: ProviderProtocolSessionV1,
): Promise<ProviderInvocationResultV1> {
  await sendCancelBestEffort(ctx, session);
  return failedAfterDispatch(ctx, session, "provider-cancelled", "invocation cancelled before a terminal result");
}

function initializeInput(
  grant: EffectiveProviderGrantV1, request: ProviderInvocationRequestV1,
  tokens: readonly RuntimeInputTokenDescriptorV1[],
): InitializeFrameInputV1 {
  return {
    grantSnapshotDigest: grant.grantSnapshotDigest,
    grantSummary: Object.freeze({ capabilityId: grant.capabilityId, surface: grant.surface }),
    inputTokens: tokens,
    effectPlanEntryDigests: request.authorityRequest.effectPlan.entries.map(
      (entry) => parseSha256Digest(canonicalDigest(entry)),
    ),
  };
}

/** Map each declared custody validator to its per-output maximum byte count (F2). */
function perFileOutputMaxima(
  validators: readonly DeclaredCustodyValidatorV1[],
): ReadonlyMap<string, number> {
  return new Map(validators.map((validator) => [validator.outputId, validator.maxOutputBytes]));
}

function failed(problem: ProviderProblemCodeV1, detail: string): ProviderInvocationResultV1 {
  return { kind: "failed", problem, detail };
}

/**
 * A failure raised once the dispatcher exists, carrying the spend the host had
 * already metered when it happened. Every post-dispatch exit routes through here
 * rather than through {@link failed}, so no observed token or cost is discarded
 * by a protocol fault, a provider-reported error, or a cancellation that landed
 * after a billable model call.
 */
/** The most provider error-frame detail carried into a host failure line, in UTF-8 bytes. */
const MAX_ERROR_FRAME_DETAIL_BYTES = 256;

function failedAfterDispatch(
  ctx: InvocationContextV1, session: ProviderProtocolSessionV1,
  problem: ProviderProblemCodeV1, detail: string,
): ProviderInvocationResultV1 {
  return {
    kind: "failed", problem, detail,
    usage: projectObservedUsage(ctx.dispatcher, session.observedBrokerRequestCount),
  };
}

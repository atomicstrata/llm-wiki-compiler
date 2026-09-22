/**
 * @file test/preparations/attempt-metering.test.ts
 * @description End-to-end token and host-priced cost metering, from the model
 * broker's settled meter through the real provider invocation and the attempt
 * leg projection to the sealed-bounds gate. It pins the behaviour the honest
 * park was standing in for: a model-capable phase whose usage the host DID
 * measure now commits with that measurement, a sub-micro-USD cost is never
 * reported as free, and a dimension the host genuinely could not observe still
 * parks rather than committing an unmeasured — or fabricated zero — dimension.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { encodeFrame } from "../../src/capability-providers/runtime/framing.js";
import { PROVIDER_PROTOCOL_VERSION_V1 } from "../../src/capability-providers/runtime/types.js";
import {
  invokeCapabilityProvider, type ProviderBackendChannelV1,
  type ProviderInvocationRequestV1, type ProviderInvocationResultV1,
} from "../../src/capability-providers/runtime/invoke.js";
import { meteredFaultUsage, projectObservedUsage } from "../../src/capability-providers/runtime/observed-usage.js";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import {
  hostModelQuoteDigest, type HostModelBrokerV1, type HostModelInvocationRequestV1,
  type HostModelQuoteObservationV1, type HostModelQuoteRequestV1,
} from "../../src/capability-providers/brokers/model.js";
import type { LLMProvider } from "../../src/utils/provider.js";
import type { HostPriceTableV1 } from "../../src/capability-providers/authority/types.js";
import { admitProviderLeg } from "../../src/preparations/attempts/admit-result.js";
import { boundsViolation } from "../../src/preparations/attempts/execute.js";
import { legFaultOutcome } from "../../src/preparations/attempts/cancel-delivery.js";
import type {
  AttemptLegOutcomeV1, PreparationProviderContextV1, SealedAttemptContextV1,
} from "../../src/preparations/attempts/types.js";
import { brokerAtom, prepareBrokerAuthority, useBrokerFixtures } from "../capability-providers/broker-fixture.js";
import { PROTOCOL_IDENTITY as IDENTITY } from "../capability-providers/protocol-identity-fixture.js";
import { useTreeFixtures } from "../capability-providers/provider-tree-fixture.js";
import { wideBounds } from "./attempt-fixture.js";

const trackFixture = useBrokerFixtures();
const { scratch, extractedSourceTree } = useTreeFixtures();
const INVOCATION = "attempt-metering";
const NONCE = "metering-nonce";
const REPORT = "metered-report";
const REPORT_DIGEST = parseSha256Digest(`sha256:${createHash("sha256").update(REPORT).digest("hex")}`);
const DECLARED = [{ outputId: "report", required: true, mediaType: "application/json" }];
/** The fixture model returns 2 input + 3 output tokens for one metered call. */
const OBSERVED_TOKENS = 5;

describe("attempt token and cost metering", () => {
  it("carries host-priced model tokens and cost onto the admitted result", async () => {
    const result = await meteredInvocation();
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.admitted.usage).toMatchObject({
      brokerRequestCount: 1, tokenCount: OBSERVED_TOKENS, costMicros: 5_000,
    });
  });

  it("commits a model-capable phase against the sealed ceilings once usage is measured", async () => {
    const outcome = await meteredLegOutcome();
    expect(outcome).toMatchObject({ phaseState: "succeeded", tokenCount: OBSERVED_TOKENS, costMicros: 5_000 });
    expect(boundsViolation(sealed({ maximumTokensPerAttempt: 100, maximumCostMicrosPerAttempt: 10_000 }), outcome))
      .toBeNull();
  });

  it.each([
    ["tokens", { maximumTokensPerAttempt: 4 }, "tokens-exceed-sealed-bound"],
    ["cost", { maximumCostMicrosPerAttempt: 4_999 }, "cost-exceed-sealed-bound"],
  ])("still refuses a measured %s overrun of the sealed ceiling", async (_dimension, bounds, reason) => {
    const outcome = await meteredLegOutcome();
    expect(boundsViolation(sealed({
      maximumTokensPerAttempt: 100, maximumCostMicrosPerAttempt: 10_000, ...bounds,
    }), outcome)).toBe(reason);
  });

  it("never reports a real sub-micro-USD cost as free", async () => {
    // 5 billable tokens at 1e-9 USD each is 0.005 micro-USD: below the reporting
    // unit, but not zero, so it must round AWAY from the host's favour.
    const outcome = await meteredLegOutcome({ price: 1e-9 });
    expect(outcome).toMatchObject({ tokenCount: OBSERVED_TOKENS, costMicros: 1 });
  });

  it("reports a measured zero for an invocation that made no model call", async () => {
    const outcome = await meteredLegOutcome({ callsModel: false });
    expect(outcome).toMatchObject({ brokerRequestCount: 0, tokenCount: 0, costMicros: 0 });
    expect(boundsViolation(sealed({ maximumTokensPerAttempt: 100, maximumCostMicrosPerAttempt: 10 }), outcome))
      .toBeNull();
  });

  it.each([
    ["tokens", { tokenCount: "unobserved" as const }, "tokens-unobserved"],
    ["cost", { costMicros: "unobserved" as const }, "cost-unobserved"],
  ])("keeps the honest park when %s were genuinely unobserved", async (_dimension, absent, reason) => {
    const outcome = { ...await meteredLegOutcome(), ...absent };
    expect(boundsViolation(sealed({ maximumTokensPerAttempt: 100, maximumCostMicrosPerAttempt: 10_000 }), outcome))
      .toBe(reason);
  });

  it("fails closed to the sentinel rather than a zero when the meter cannot be read", () => {
    const usage = projectObservedUsage(Object.freeze({}) as never, 3);
    expect(usage).toEqual({ brokerRequestCount: 3, tokenCount: "unobserved", costMicros: "unobserved" });
  });

  it("rounds a genuinely fractional micro-USD cost UP rather than snapping it down", async () => {
    // 5 tokens at 9.999999808 USD is 49.99999904 USD — 49999999.04 micro-USD.
    // A magnitude-scaled boundary tolerance would swallow that .04 and report
    // one micro LESS than was really spent, understating against the ceiling.
    const outcome = await meteredLegOutcome({ price: 9.999999808 });
    expect(outcome).toMatchObject({ tokenCount: OBSERVED_TOKENS, costMicros: 50_000_000 });
  });

  it.each([
    ["a provider-reported error", { ending: "error" as const }, "provider-failed"],
    ["a malformed error frame", { ending: "malformed" as const }, "provider-protocol-invalid"],
    ["a stream closing before any terminal frame", { ending: "silence" as const }, "provider-protocol-invalid"],
  ])("keeps spend already observed when the invocation ends in %s", async (_ending, run, problem) => {
    const outcome = await meteredLegOutcome(run);
    // Pinning `problem` pins WHICH host exit ran; without it a scenario could
    // silently fall through to a different one and still look covered.
    expect(outcome).toMatchObject({
      phaseState: "failed", problem, brokerRequestCount: 1,
      tokenCount: OBSERVED_TOKENS, costMicros: 5_000,
    });
  });

  it("keeps spend already observed when a cancel lands after the model call", async () => {
    const controller = new AbortController();
    const outcome = await meteredLegOutcome({
      ending: "silence", hostSignal: controller.signal, afterModelCall: () => controller.abort(),
    });
    expect(outcome).toMatchObject({
      phaseState: "cancelled", brokerRequestCount: 1, tokenCount: OBSERVED_TOKENS, costMicros: 5_000,
    });
  });

  it("keeps spend already observed when recustody of the output fails", async () => {
    const outcome = await admitProviderLeg(unrecustodiableResult(), providerContext(), 1 << 20, true);
    expect(outcome).toMatchObject({
      phaseState: "failed", problem: "provider-output-recustody-failed",
      brokerRequestCount: 1, tokenCount: OBSERVED_TOKENS, costMicros: 5_000,
    });
  });

  it("carries the admitted detail of a completed-but-partial result as the leg's problemDetail", async () => {
    // The failed-invocation path already threads its detail onto the leg; the
    // completed-partial path dropped it, so every diagnostic printed `detail=?` for the
    // one class where the reason matters most — a provider that ran and produced nothing.
    const outcome = await admitProviderLeg(partialResult("provider reported failure (untrusted): latexmk failed after 3 rounds; missing required outputs: main-pdf"), providerContext(), 1 << 20, true);
    expect(outcome).toMatchObject({ phaseState: "failed", problem: "provider-partial" });
    expect(outcome.problemDetail).toMatch(/^provider reported failure \(untrusted\): latexmk failed after 3 rounds; missing required outputs: main-pdf$/);
  });

  it("bounds a multibyte over-cap problemDetail to the stated 512 bytes WITH its ellipsis", async () => {
    // A three-byte "…" appended after a cut at cap-1 persisted 514 bytes; the cap is a
    // byte bound on the STORED value, ellipsis included.
    const outcome = await admitProviderLeg(partialResult("é".repeat(600)), providerContext(), 1 << 20, true);
    expect(outcome.problemDetail?.endsWith("…")).toBe(true);
    expect(Buffer.byteLength(outcome.problemDetail ?? "", "utf8")).toBeLessThanOrEqual(512);
  });

  // Two DIFFERENT post-dispatch throw sites — a backend send (the reviewer's
  // reproduction) and a terminal custody step. Neither is a protocol fault, so
  // both used to unwind straight past the result path. They are covered by one
  // wrapper, so exercising both is what evidences the CLASS is closed rather
  // than the single reported instance.
  it.each([
    ["a backend send", { failSendAfter: 2 }],
    ["a terminal custody step", { failOutputRoot: true }],
  ])("keeps spend already observed when %s throws after the model call", async (_site, run) => {
    const fault = await meteredInvocation(run).then(
      (result) => { throw new Error(`expected a fault, got ${result.kind}`); },
      (error: unknown) => error,
    );
    expect(meteredFaultUsage(fault)).toEqual({
      brokerRequestCount: 1, tokenCount: OBSERVED_TOKENS, costMicros: 5_000,
    });
  });

  it.each([
    ["a backend send", { failSendAfter: 2 }],
    ["a terminal custody step", { failOutputRoot: true }],
  ])("parks a metered %s fault recovery-required WITH its spend", async (_site, run) => {
    const fault = await meteredInvocation(run).catch((error: unknown) => error);
    // Classification must not move: a thrown leg stays recovery-required, which
    // retry refuses. Only the measurement is added alongside it.
    expect(legFaultOutcome(fault)).toMatchObject({
      phaseState: "recovery-required", problem: "leg-fault",
      brokerRequestCount: 1, tokenCount: OBSERVED_TOKENS, costMicros: 5_000,
    });
  });

  it("stays unobserved when the invocation failed before any broker could be dispatched", async () => {
    const result = await meteredInvocation({ infeasibleCustody: true });
    expect(result).toMatchObject({ kind: "failed", problem: "provider-resource-exhausted" });
    expect(await meteredLegOutcome({ infeasibleCustody: true })).toMatchObject({
      phaseState: "failed", brokerRequestCount: 0, tokenCount: "unobserved", costMicros: "unobserved",
    });
  });
});

/**
 * A completed admission whose accepted artifact points at bytes that are gone,
 * so recustody fails AFTER the model spend was already metered.
 */
function unrecustodiableResult(): ProviderInvocationResultV1 {
  const evidence = { evidencePath: path.join("/nonexistent-llmwiki-metering", "report"), digest: REPORT_DIGEST, byteCount: REPORT.length };
  return {
    kind: "completed",
    admitted: {
      outcome: "succeeded",
      acceptedArtifacts: [{ outputId: "report", mediaType: "application/json", digest: REPORT_DIGEST, byteCount: REPORT.length, evidence }],
      counts: { declared: 1, acceptedArtifacts: 1, requiredMissing: 0, receipts: 0 },
      receipts: [], usage: { brokerRequestCount: 1, tokenCount: OBSERVED_TOKENS, costMicros: 5_000 },
      untrusted: { untrusted: true, providerReportedCounts: null, warnings: null, output: null },
    },
  } as ProviderInvocationResultV1;
}

/** Build the sealed context the bounds gate reads; only `bounds` is consulted. */
function sealed(bounds: Partial<ReturnType<typeof wideBounds>>): SealedAttemptContextV1 {
  return { bounds: { ...wideBounds(), maximumBrokerRequestsPerAttempt: 4, ...bounds } } as SealedAttemptContextV1;
}

/** Orchestration identity for the leg projection; never a run or store path. */
function providerContext(): PreparationProviderContextV1 {
  return {
    preparationRunId: "broker-preparation", phaseInstanceId: "pi_metering" as never,
    attemptId: "at_metering" as never, leaseNonce: NONCE,
    providerPinDigest: IDENTITY.providerPinDigest, inputExposureSetDigest: IDENTITY.packageDigest,
  };
}

/** How one scripted invocation should behave; every field has an honest default. */
interface MeteredRunV1 {
  readonly price?: number;
  readonly callsModel?: boolean;
  /** How the provider conversation ends after the (optional) model call. */
  readonly ending?: "result" | "error" | "malformed" | "silence";
  /** Fires once the model adapter has produced its billable observation. */
  readonly afterModelCall?: () => void;
  readonly hostSignal?: AbortSignal;
  /** Declare custody the resolved grant cannot satisfy, refusing before launch. */
  readonly infeasibleCustody?: boolean;
  /** Reject the Nth backend send (0-based), simulating a dead backend channel. */
  readonly failSendAfter?: number;
  /** Reject the terminal custody step that resolves the backend output root. */
  readonly failOutputRoot?: boolean;
}

/** A completed invocation whose admission classified it PARTIAL, carrying the admitted detail. */
function partialResult(detail: string): ProviderInvocationResultV1 {
  return {
    kind: "completed",
    admitted: {
      outcome: "partial", problem: "provider-partial", detail,
      receipts: [], usage: { brokerRequestCount: 1, tokenCount: OBSERVED_TOKENS, costMicros: 5_000 },
      untrusted: { untrusted: true, providerReportedCounts: null, warnings: null, output: null },
    },
  };
}

/** Run one real metered invocation and project it onto the attempt surface. */
async function meteredLegOutcome(run: MeteredRunV1 = {}): Promise<AttemptLegOutcomeV1> {
  return admitProviderLeg(await meteredInvocation(run), providerContext(), 1 << 20, true);
}

/** Drive the real provider runtime over a scripted backend and a real model broker. */
async function meteredInvocation(run: MeteredRunV1 = {}): Promise<ProviderInvocationResultV1> {
  const fixture = trackFixture(await prepareBrokerAuthority({
    authority: [brokerAtom({
      kind: "model.invoke", brokerId: "model", operation: "complete-summary",
      target: "test-service/test-model",
    })],
    priceTable: priceTable(run.price ?? 0.001),
  }));
  const outputDir = await scratch("llmwiki-metering-out-");
  await writeFile(path.join(outputDir, "report"), REPORT);
  const request: ProviderInvocationRequestV1 = {
    paths: fixture.package.paths, invocationId: INVOCATION as never, nonce: NONCE,
    expectedIdentity: IDENTITY, authorityRequest: fixture.request,
    launch: { ...await extractedSourceTree(), launchParentDir: await scratch("llmwiki-metering-launch-") },
    input: { query: "sources" }, inputSpecs: [], operationContext: {},
    declaredOutputs: DECLARED, brokers: { model: modelBroker(run.afterModelCall) },
    custodyValidators: [{
      outputId: "report", maxOutputBytes: run.infeasibleCustody === true ? 900_000 : 40,
      worstCaseScanPasses: 1, worstCaseWallTimeMs: 50,
    }],
    ...(run.hostSignal === undefined ? {} : { hostSignal: run.hostSignal }),
  };
  const channel = new ScriptedChannel(
    frames(run.callsModel !== false, run.ending ?? "result"), outputDir,
    run.failSendAfter, run.failOutputRoot === true,
  );
  return invokeCapabilityProvider(request, { backend: { launch: async () => channel } });
}

/** The scripted provider conversation, optionally including one model call. */
function frames(callsModel: boolean, ending: "result" | "error" | "malformed" | "silence"): readonly unknown[] {
  const modelFrame = providerFrame("broker-request", 1, {
    request: {
      schemaVersion: 1, requestId: "r1", brokerId: "model", brokerContractVersion: "1.0.0",
      payload: {
        operation: "complete-summary", system: "system",
        messages: [{ role: "user", content: "hello" }], tools: null, maxOutputTokens: 8,
      },
      effect: null,
    },
  });
  const claim = { outputId: "report", outputToken: "report", claimedDigest: REPORT_DIGEST, claimedByteCount: REPORT.length };
  const sequence = callsModel ? 2 : 1;
  const terminal = ending === "result"
    ? [providerFrame("result", sequence, { result: { outcome: "succeeded", artifactClaims: [claim] } })]
    // `provider-failed` is a published problem code, so the session admits the
    // frame as a real error EVENT; an unpublished code is rejected as a framing
    // fault instead. The two reach different host exits, so both are scripted.
    : ending === "error"
      ? [providerFrame("error", sequence, { code: "provider-failed", detail: "backend gave up" })]
      : ending === "malformed"
        ? [providerFrame("error", sequence, { code: "not-a-published-code", detail: "backend gave up" })]
        : [];
  return [initializedFrame(), ...(callsModel ? [modelFrame] : []), ...terminal];
}

/** A quote/invoke model adapter that reports exact host-observed billable usage. */
function modelBroker(afterModelCall?: () => void): HostModelBrokerV1 {
  return {
    provider: { complete: vi.fn(), stream: vi.fn(), toolCall: vi.fn(), embed: vi.fn() } as unknown as LLMProvider,
    operations: [{
      operationId: "complete-summary", targetIdentity: "test-service/test-model",
      service: "test-service", model: "test-model", mode: "complete",
      maxPromptBytes: 1_024, maxContextItems: 8, maxInputTokens: 32,
      maxOutputTokens: 8, priceUnit: "token", timeoutMs: 1_000,
    }],
    quote: async (request: HostModelQuoteRequestV1) => exactQuote(request),
    invoke: async (request: HostModelInvocationRequestV1) => {
      const observation = {
        service: "test-service", model: "test-model", output: "model output",
        requestDigest: request.requestDigest, quoteDigest: request.quoteDigest,
        inputTokens: 2, outputTokens: 3, billableTokens: OBSERVED_TOKENS,
      };
      afterModelCall?.();
      return observation;
    },
  };
}

/** The exact request-bound quote the host validates before any billable I/O. */
function exactQuote(request: HostModelQuoteRequestV1): HostModelQuoteObservationV1 {
  const base = {
    service: "test-service", model: "test-model", requestDigest: request.requestDigest,
    inputTokens: 2, maximumOutputTokens: request.maximumOutputTokens,
    maximumBillableTokens: 2 + request.maximumOutputTokens,
  };
  return { ...base, quoteDigest: hostModelQuoteDigest(base) };
}

function priceTable(priceUsdPerUnit: number): HostPriceTableV1 {
  return {
    schemaVersion: 1, currency: "USD", validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2027-01-01T00:00:00.000Z", entries: [{
      brokerContract: "model:1.0.0", service: "test-service", modelOrSku: "test-model",
      unit: "token", priceUsdPerUnit,
    }],
  };
}

function providerFrame(type: string, sequence: number, extra: Record<string, unknown>) {
  return {
    protocolVersion: PROVIDER_PROTOCOL_VERSION_V1, invocationId: INVOCATION,
    requestId: `p-${sequence}`, sequence, type, ...extra,
  };
}

function initializedFrame() {
  return providerFrame("initialized", 0, {
    selectedProtocolVersion: PROVIDER_PROTOCOL_VERSION_V1,
    echoedIdentity: {
      providerPinDigest: IDENTITY.providerPinDigest, packageDigest: IDENTITY.packageDigest,
      manifestDigest: IDENTITY.manifestDigest, artifactDigest: IDENTITY.artifactDigest,
      capabilityId: "analyze-sources", capabilitySchemaDigest: IDENTITY.capabilitySchemaDigest,
    },
    nonce: NONCE, declaredCapabilityId: "analyze-sources",
  });
}

/** A scripted framed channel replaying provider frames over a real output root. */
class ScriptedChannel implements ProviderBackendChannelV1 {
  private index = 0;
  private sends = 0;
  constructor(
    private readonly script: readonly unknown[], private readonly outputDir: string,
    private readonly failSendAfter?: number, private readonly failOutputRoot = false,
  ) {}
  async send(): Promise<void> {
    const ordinal = this.sends++;
    if (ordinal === this.failSendAfter) throw new Error("backend channel is gone");
  }
  async receive(): Promise<Buffer | null> {
    return this.index >= this.script.length ? null : encodeFrame(this.script[this.index++]);
  }
  async outputRoot(): Promise<string> {
    if (this.failOutputRoot) throw new Error("backend output root is unavailable");
    return this.outputDir;
  }
  async terminate(): Promise<void> {}
}

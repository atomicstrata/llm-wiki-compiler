/**
 * @file test/capability-providers/model-broker.test.ts
 * @description Model broker integration tests for exact host usage, pinned
 * pricing, aggregate accounting, and fail-closed legacy LLMProvider adaptation.
 */
import { describe, expect, it, vi } from "vitest";
import type { LLMProvider } from "../../src/utils/provider.js";
import {
  createHostBrokerDispatcher, dispatchHostBrokerRequest, readHostBrokerUsage,
} from "../../src/capability-providers/brokers/dispatch.js";
import { getEventListeners } from "node:events";
import { hostModelQuoteDigest, type HostModelBrokerV1, type HostModelQuoteRequestV1 as ModelQuoteRequest, type HostModelInvocationRequestV1 as ModelInvocationRequest } from "../../src/capability-providers/brokers/model.js";
import { withModelDeadline } from "../../src/capability-providers/brokers/model-execution.js";
import { createInvocationDeadline } from "../../src/capability-providers/brokers/deadline.js";
import {
  hostPriceTableDigest, writeOperatorPriceTable,
} from "../../src/capability-providers/authority/pricing.js";
import type { HostPriceTableV1 } from "../../src/capability-providers/authority/types.js";
import { parseInvocationId, parseSha256Digest } from "../../src/capability-providers/ids.js";
import {
  brokerAtom, brokerEnvelope, prepareBrokerAuthority, useBrokerFixtures,
} from "./broker-fixture.js";

const trackFixture = useBrokerFixtures();

describe("model broker", () => {
  it("captures a class provider opaquely but requires the quote/invoke adapter", async () => {
    const provider = new ClassProvider();
    const base = modelBroker(provider.complete.bind(provider), false);
    const prepared = await setup({ ...base, provider });
    const result = await dispatchHostBrokerRequest(prepared.dispatcher, modelRequest());
    expect(result.status).toBe("unavailable");
    expect(provider.calls).toBe(0);
  });

  it("refuses a token-dense prompt over a one-token quote cap before invoke", async () => {
    const complete = vi.fn(async () => "model output");
    const base = modelBroker(complete, true);
    const invoke = vi.fn(base.invoke);
    const model = { ...base,
      operations: [{ ...base.operations[0], maxInputTokens: 1 }],
      quote: async (request: ModelQuoteRequest) => modelQuote(request, 2),
      invoke };
    const prepared = await setup(model);
    const result = await dispatchHostBrokerRequest(prepared.dispatcher, modelRequest());
    expect(result.status).toBe("refused");
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["token", { modelTokens: 9 }],
    ["cost", { modelCostUsd: 0.009 }],
  ])("uses the narrow per-broker model-%s maximum before invoke", async (_kind, action) => {
    const base = modelBroker(vi.fn(async () => "model output"), true);
    const invoke = vi.fn(base.invoke);
    const prepared = await setup({ ...base, invoke }, { action });
    expect((await dispatchHostBrokerRequest(prepared.dispatcher, modelRequest())).status)
      .toBe("refused");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("settles the meter down to exact host-observed tokens and cost on success", async () => {
    const complete = vi.fn(async () => "model output");
    const prepared = await setup(modelBroker(complete, true));
    const result = await dispatchHostBrokerRequest(prepared.dispatcher, modelRequest());
    expect(result).toMatchObject({ status: "ok", output: {
      service: "test-service", model: "test-model", inputTokens: 2,
      outputTokens: 3, costUsd: 0.005,
    } });
    const usage = readHostBrokerUsage(prepared.dispatcher);
    expect(usage).toMatchObject({ brokerRequests: 1, modelCalls: 1, modelTokens: 5 });
    expect(usage.modelCostUsd).toBeCloseTo(0.005);
    expect(complete).toHaveBeenCalledWith("system", [{ role: "user", content: "hello" }], 8);
  });

  it("fails closed and keeps the reservation when observed usage is absent", async () => {
    const model = { ...modelBroker(vi.fn(async () => "model output"), true),
      invoke: async (request: ModelInvocationRequest) => ({
        service: "test-service", model: "test-model", output: "model output",
        requestDigest: request.requestDigest, quoteDigest: request.quoteDigest,
        inputTokens: 2, outputTokens: 3,
      } as never) };
    const prepared = await setup(model);
    const result = await dispatchHostBrokerRequest(prepared.dispatcher, modelRequest());
    expect(result.status).toBe("unavailable");
    expect(readHostBrokerUsage(prepared.dispatcher).modelTokens).toBe(10);
  });

  it("does not call a legacy LLMProvider when exact usage is unavailable", async () => {
    const complete = vi.fn(async () => "unmetered output");
    const prepared = await setup(modelBroker(complete, false));
    const result = await dispatchHostBrokerRequest(prepared.dispatcher, modelRequest());
    expect(result).toMatchObject({ status: "unavailable", output: {
      reason: expect.stringMatching(/usage|pricing/i),
    } });
    expect(complete).not.toHaveBeenCalled();
  });

  it("re-resolves Task 5 pricing and rejects drift before model I/O", async () => {
    const complete = vi.fn(async () => "model output");
    const prepared = await setup(modelBroker(complete, true));
    const drifted = priceTable(0.002);
    await writeOperatorPriceTable(
      prepared.fixture.package.paths, drifted, hostPriceTableDigest(drifted),
    );
    await expect(dispatchHostBrokerRequest(prepared.dispatcher, modelRequest()))
      .rejects.toThrow(/pricing.*drift|authority.*drift/i);
    expect(complete).not.toHaveBeenCalled();
  });

  it("fails closed on routed identity mismatch after reserving the call ceiling", async () => {
    const complete = vi.fn(async () => "model output");
    const model = { ...modelBroker(complete, true), invoke: async (request: ModelInvocationRequest) => ({
      service: "wrong-service", model: "test-model", output: "model output",
      requestDigest: request.requestDigest, quoteDigest: request.quoteDigest,
      inputTokens: 2, outputTokens: 3, billableTokens: 5,
    }) };
    const prepared = await setup(model);
    const result = await dispatchHostBrokerRequest(prepared.dispatcher, modelRequest());
    expect(result.status).toBe("refused");
    expect(readHostBrokerUsage(prepared.dispatcher).modelTokens).toBe(10);
  });

  it("charges observed billable usage above the quote before refusing it", async () => {
    const base = modelBroker(vi.fn(async () => "model output"), true);
    const model = { ...base, invoke: async (request: ModelInvocationRequest) => ({
      service: "test-service", model: "test-model", output: "model output",
      requestDigest: request.requestDigest, quoteDigest: request.quoteDigest,
      inputTokens: 2, outputTokens: 9, billableTokens: 11,
    }) };
    const prepared = await setup(model);
    const result = await dispatchHostBrokerRequest(prepared.dispatcher, modelRequest());
    expect(result.status).toBe("refused");
    const usage = readHostBrokerUsage(prepared.dispatcher);
    expect(usage.modelTokens).toBe(11);
    expect(usage.modelCostUsd).toBeCloseTo(0.011);
  });

  it.each([
    ["identity", (quote: ReturnType<typeof modelQuote>) => ({ ...quote, service: "wrong" })],
    ["digest", (quote: ReturnType<typeof modelQuote>) => ({ ...quote, quoteDigest: parseSha256Digest(`sha256:${"f".repeat(64)}`) })],
    ["usage", (quote: ReturnType<typeof modelQuote>) => ({
      ...quote, maximumBillableTokens: quote.maximumBillableTokens + 1,
    })],
  ])("refuses quote %s mismatch before invoke", async (_kind, mutate) => {
    const base = modelBroker(vi.fn(async () => "model output"), true);
    const invoke = vi.fn(base.invoke);
    const model = { ...base, quote: async (request: ModelQuoteRequest) => mutate(modelQuote(request, 2)), invoke };
    const prepared = await setup(model);
    expect((await dispatchHostBrokerRequest(prepared.dispatcher, modelRequest())).status).toBe("refused");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("aborts and returns within the registered model deadline", async () => {
    let aborted = false;
    const base = modelBroker(vi.fn(), true);
    const model = { ...base, operations: [{ ...base.operations[0], timeoutMs: 10 }],
      invoke: async (request: { readonly signal: AbortSignal }) => new Promise<never>(() => {
        request.signal.addEventListener("abort", () => { aborted = true; });
      }) };
    const prepared = await setup(model);
    const result = await dispatchHostBrokerRequest(prepared.dispatcher, modelRequest());
    expect(result.status).toBe("unavailable");
    expect(aborted).toBe(true);
  });

  /**
   * A REJECTED RACE IS NOT AN UNCALLED ADAPTER. `Promise.race([action(signal),
   * deadline])` has to evaluate `action(signal)` to build its array, so aborting
   * the controller and rejecting the deadline still CALLED the model adapter —
   * handing it a pre-aborted signal it was free to ignore. Only the call count
   * distinguishes the two; asserting the rejection alone passes either way.
   */
  it("never calls the model adapter when the deadline is already spent", async () => {
    const clock = { elapsed: 0 };
    const deadline = createInvocationDeadline(
      new AbortController().signal, 50_000, () => clock.elapsed);
    clock.elapsed = 50_001;
    const action = vi.fn(async () => "unreachable" as const);

    await expect(withModelDeadline(60_000, deadline, action)).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
    expect(deadline.signal.aborted).toBe(false);
  });

  it("removes its host-deadline listener after each model call to avoid a leak", async () => {
    // Built through the production constructor so the listener is counted on the
    // same composed signal the broker actually subscribes to.
    const deadline = createInvocationDeadline(new AbortController().signal, 60_000);
    for (let call = 0; call < 8; call += 1) {
      await withModelDeadline(60_000, deadline, async () => "ok" as const);
    }
    expect(getEventListeners(deadline.signal, "abort")).toHaveLength(0);
  });

  it("aborts an in-flight model call at the host invocation deadline", async () => {
    const controller = new AbortController();
    const base = modelBroker(vi.fn(async () => "model output"), true);
    const invoke = vi.fn((request: { readonly signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("host deadline")), { once: true });
    }));
    const model = { ...base, operations: [{ ...base.operations[0], timeoutMs: 60_000 }], invoke };
    const prepared = await setup(model, undefined, controller.signal);
    const pending = dispatchHostBrokerRequest(prepared.dispatcher, modelRequest());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    controller.abort();
    expect((await pending).status).toBe("unavailable");
  });
});

function modelRequest() {
  return brokerEnvelope("model", {
    operation: "complete-summary", system: "system",
    messages: [{ role: "user", content: "hello" }], tools: null,
    maxOutputTokens: 8,
  });
}

function modelBroker(complete: LLMProvider["complete"], withUsage: boolean) {
  const provider = {
    complete, stream: complete, toolCall: vi.fn(), embed: vi.fn(),
  } as unknown as LLMProvider;
  return {
    provider, operations: [{
      operationId: "complete-summary", targetIdentity: "test-service/test-model",
      service: "test-service", model: "test-model", mode: "complete" as const,
      maxPromptBytes: 1_024, maxContextItems: 8, maxInputTokens: 32,
      maxOutputTokens: 8, priceUnit: "token", timeoutMs: 1_000,
    }],
    ...(withUsage ? {
      quote: async (request: ModelQuoteRequest) => modelQuote(request, 2),
      invoke: async (request: ModelInvocationRequest) => ({
      service: "test-service", model: "test-model",
      requestDigest: request.requestDigest, quoteDigest: request.quoteDigest,
      output: await complete("system", [{ role: "user", content: "hello" }], 8),
      inputTokens: 2, outputTokens: 3, billableTokens: 5,
    }) } : {}),
  };
}

class ClassProvider implements LLMProvider {
  calls = 0;
  async complete() { this.calls += 1; return "legacy"; }
  async stream() { this.calls += 1; return "legacy"; }
  async toolCall() { this.calls += 1; return "legacy"; }
  async embed() { this.calls += 1; return [1]; }
}
function modelQuote(request: ModelQuoteRequest, inputTokens: number) {
  const quote = {
    service: "test-service", model: "test-model", requestDigest: request.requestDigest,
    inputTokens, maximumOutputTokens: request.maximumOutputTokens,
    maximumBillableTokens: inputTokens + request.maximumOutputTokens,
  };
  return { ...quote, quoteDigest: hostModelQuoteDigest(quote) };
}

async function setup(
  model: HostModelBrokerV1,
  brokerMaximumOverrides?: Parameters<typeof prepareBrokerAuthority>[0]["brokerMaximumOverrides"],
  deadlineSignal?: AbortSignal,
) {
  const authority = [brokerAtom({
    kind: "model.invoke", brokerId: "model", operation: "complete-summary",
    target: "test-service/test-model",
  })];
  const fixture = trackFixture(await prepareBrokerAuthority({
    authority, priceTable: priceTable(0.001), brokerMaximumOverrides,
  }));
  const dispatcher = await createHostBrokerDispatcher({
    paths: fixture.package.paths, authorityRequest: fixture.request,
    invocationId: parseInvocationId("invocation-model"), brokers: { model },
    now: () => new Date("2026-07-18T12:30:00.000Z"),
    ...(deadlineSignal ? { deadlineSignal } : {}),
  });
  return { fixture, dispatcher };
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

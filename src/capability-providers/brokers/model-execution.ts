/**
 * @file src/capability-providers/brokers/model-execution.ts
 * @description Host-owned model quote, reservation, invocation, and settlement.
 * A digest-pinned price and an exact host quote are reserved before billable
 * I/O; on completion the meter settles to the exact observed usage, and a
 * stalled call aborts at the earlier of its timeout and the host deadline.
 */
import { captureExactRecord } from "../../utils/runtime-capture.js";
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { resolveHostPrice } from "../authority/pricing.js";
import { parseSha256Digest } from "../ids.js";
import type { Sha256Digest } from "../types.js";
import type {
  HostBrokerBudgetV1, HostBrokerExecutionContextV1, HostBrokerExecutionV1, HostBrokerUsageV1,
} from "./types.js";
import { brokerFailure } from "./types.js";
import type { HostInvocationDeadlineV1 } from "./deadline.js";
import type {
  HostModelBrokerV1, HostModelInvocationObservationV1, HostModelOperationV1,
  HostModelQuoteObservationV1, ModelContext, ModelPayload,
} from "./model.js";

type ResolvedModelPrice = Awaited<ReturnType<typeof resolveHostPrice>>;
interface ModelReservation {
  readonly price: ResolvedModelPrice;
  readonly quote: HostModelQuoteObservationV1;
  readonly maximumCost: number;
}

/** Reserve a quoted model call, invoke it, and settle the meter to observed usage. */
export async function executeModel(
  broker: HostModelBrokerV1, operation: HostModelOperationV1, payload: ModelPayload,
  requestDigest: Sha256Digest, context: ModelContext, execution: HostBrokerExecutionContextV1,
): Promise<HostBrokerExecutionV1> {
  if (!broker.quote || !broker.invoke || context.priceTableDigest === null) {
    return response("unavailable", "exact model usage or pricing is unavailable");
  }
  if (execution.deadline.expired()) return response("unavailable", "model call exceeded the invocation deadline");
  const reservation = await reserveQuotedModel(
    broker, operation, payload, requestDigest, context, execution.budget,
    execution.reserve, execution.deadline,
  );
  if ("outcome" in reservation) return reservation;
  return executeQuotedModel(
    broker, operation, payload, requestDigest, reservation,
    execution.reserve, execution.settle, execution.deadline,
  );
}

async function reserveQuotedModel(
  broker: HostModelBrokerV1, operation: HostModelOperationV1, payload: ModelPayload,
  requestDigest: Sha256Digest, context: ModelContext, budget: HostBrokerBudgetV1,
  reserve: (usage: HostBrokerUsageV1) => boolean, deadline: HostInvocationDeadlineV1,
): Promise<ModelReservation | HostBrokerExecutionV1> {
  const price = await modelPrice(operation, context);
  if (!price) return response("unavailable", "model pricing is unavailable or drifted");
  const quote = await quoteModel(broker, operation, payload, requestDigest, deadline);
  if (!quote) return response("unavailable", "model quote is unavailable");
  if (!validModelQuote(quote, operation, payload, requestDigest)) {
    return response("refused", "model quote did not match authorization");
  }
  const maximumCost = quote.maximumBillableTokens * price.priceUsdPerUnit;
  if (!reserveModelMaximum(quote.maximumBillableTokens, maximumCost, budget, reserve)) {
    return response("refused", "model aggregate cap is exhausted");
  }
  return { price, quote, maximumCost };
}

async function executeQuotedModel(
  broker: HostModelBrokerV1, operation: HostModelOperationV1, payload: ModelPayload,
  requestDigest: Sha256Digest, reservation: ModelReservation,
  reserve: (usage: HostBrokerUsageV1) => boolean,
  settle: (released: HostBrokerUsageV1) => void, deadline: HostInvocationDeadlineV1,
): Promise<HostBrokerExecutionV1> {
  const { quote, price, maximumCost } = reservation;
  let observed: HostModelInvocationObservationV1;
  try { observed = captureObservation(await invokeModel(
    broker, operation, payload, quote, maximumCost, deadline,
  )); }
  catch { return response("unavailable", "model invocation is unavailable"); }
  const excessCharged = chargeModelExcess(
    observed, quote, maximumCost, price.priceUsdPerUnit, reserve,
  );
  if (!validModelObservation(observed, operation, quote)) {
    return reservedResponse("refused", excessCharged
      ? "model identity or usage did not match authorization"
      : "model usage exceeded the aggregate cap");
  }
  settleModelReservation(settle, quote, maximumCost, observed, price.priceUsdPerUnit);
  return successfulModelExecution(observed, price, requestDigest);
}

/** Release the reserved-quote overage the model did not actually consume. */
function settleModelReservation(
  settle: (released: HostBrokerUsageV1) => void,
  quote: HostModelQuoteObservationV1, maximumCost: number,
  observed: HostModelInvocationObservationV1, priceUsdPerUnit: number,
): void {
  const releasedTokens = Math.max(0, quote.maximumBillableTokens - observed.billableTokens);
  const releasedCost = Math.max(0, maximumCost - observed.billableTokens * priceUsdPerUnit);
  if (releasedTokens > 0 || releasedCost > 0) {
    settle({ modelTokens: releasedTokens, modelCostUsd: releasedCost });
  }
}

function successfulModelExecution(
  observed: HostModelInvocationObservationV1, price: ResolvedModelPrice,
  requestDigest: Sha256Digest,
): HostBrokerExecutionV1 {
  const cost = observed.billableTokens * price.priceUsdPerUnit;
  const responseDigest = parseSha256Digest(canonicalDigest({
    service: observed.service, model: observed.model, output: observed.output,
  }));
  return Object.freeze({
    outcome: "ok", output: Object.freeze({
      service: observed.service, model: observed.model, output: observed.output,
      inputTokens: observed.inputTokens, outputTokens: observed.outputTokens,
      costUsd: cost, priceTableDigest: price.priceTableDigest,
      requestDigest, responseDigest,
    }), usageReserved: true,
    visibleBytes: Object.freeze([Buffer.from(observed.output)]), responseDigest,
  });
}

function chargeModelExcess(
  observed: HostModelInvocationObservationV1, quote: HostModelQuoteObservationV1,
  maximumCost: number, priceUsdPerUnit: number,
  reserve: (usage: HostBrokerUsageV1) => boolean,
): boolean {
  const modelTokens = Math.max(0, observed.billableTokens - quote.maximumBillableTokens);
  const modelCostUsd = Math.max(0, observed.billableTokens * priceUsdPerUnit - maximumCost);
  return (modelTokens === 0 && modelCostUsd === 0)
    || reserve({ modelTokens, modelCostUsd });
}

async function modelPrice(
  operation: HostModelOperationV1, context: ModelContext,
): Promise<ResolvedModelPrice | null> {
  try {
    return await resolveHostPrice(context.paths, {
      brokerContract: "model:1.0.0", service: operation.service,
      modelOrSku: operation.model, unit: operation.priceUnit, currency: "USD",
    }, context.priceTableDigest!, context.now);
  } catch { return null; }
}

function reserveModelMaximum(
  tokens: number, cost: number, budget: HostBrokerBudgetV1,
  reserve: (usage: HostBrokerUsageV1) => boolean,
): boolean {
  return tokens <= budget.modelTokens && cost <= budget.modelCostUsd
    && reserve({ modelTokens: tokens, modelCostUsd: cost });
}

function validModelObservation(
  observed: HostModelInvocationObservationV1,
  operation: HostModelOperationV1, quote: HostModelQuoteObservationV1,
): boolean {
  return observed.service === operation.service && observed.model === operation.model
    && observed.requestDigest === quote.requestDigest
    && observed.quoteDigest === quote.quoteDigest
    && observed.inputTokens === quote.inputTokens
    && observed.outputTokens <= quote.maximumOutputTokens
    && observed.billableTokens === observed.inputTokens + observed.outputTokens;
}

async function invokeModel(
  broker: HostModelBrokerV1, operation: HostModelOperationV1, payload: ModelPayload,
  quote: HostModelQuoteObservationV1, maximumCostUsd: number, deadline: HostInvocationDeadlineV1,
): Promise<HostModelInvocationObservationV1> {
  return withModelDeadline(operation.timeoutMs, deadline, (signal) => broker.invoke!(Object.freeze({
    service: operation.service, model: operation.model,
    mode: operation.mode, system: payload.system, messages: payload.messages,
    tools: payload.tools, requestDigest: quote.requestDigest, quoteDigest: quote.quoteDigest,
    exactInputTokens: quote.inputTokens, maximumOutputTokens: quote.maximumOutputTokens,
    maximumBillableTokens: quote.maximumBillableTokens, maximumCostUsd, signal,
  })));
}

async function quoteModel(
  broker: HostModelBrokerV1, operation: HostModelOperationV1, payload: ModelPayload,
  requestDigest: Sha256Digest, deadline: HostInvocationDeadlineV1,
): Promise<HostModelQuoteObservationV1 | null> {
  try {
    const observed = await withModelDeadline(operation.timeoutMs, deadline, (signal) => broker.quote!(Object.freeze({
      service: operation.service, model: operation.model, mode: operation.mode,
      system: payload.system, messages: payload.messages, tools: payload.tools,
      maximumOutputTokens: payload.maxOutputTokens, requestDigest, signal,
    })));
    return captureQuote(observed);
  } catch { return null; }
}

/**
 * Race one model adapter call against the earlier of its per-operation timeout
 * and the host invocation deadline. Either firing aborts the adapter's signal
 * and rejects, so a stalled model call cannot outlive the host wall-time bound.
 * Exactly one host-deadline listener is registered and always removed, so a
 * completed call leaves no listener on the shared deadline across an invocation.
 */
export async function withModelDeadline<T>(
  timeoutMs: number, hostDeadline: HostInvocationDeadlineV1, action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  // Refuse BEFORE `action` is evaluated. Rejecting a raced promise does NOT
  // prevent the call: `Promise.race([action(signal), deadline])` must evaluate
  // `action(signal)` to build the array, so an already-expired deadline still
  // reached the adapter — with a pre-aborted signal it was free to ignore.
  // The race decides which result wins, never whether the call happens.
  if (hostDeadline.expired()) throw unavailableError();
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  let onHostAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    const abort = () => { controller.abort(); reject(unavailableError()); };
    // Expiry is excluded above, so this only has to arm cancellation of the
    // call that is about to start.
    onHostAbort = abort;
    hostDeadline.signal.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(abort, timeoutMs);
  });
  try {
    return await Promise.race([action(controller.signal), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onHostAbort) hostDeadline.signal.removeEventListener("abort", onHostAbort);
  }
}

/** Canonical digest the host quote adapter must return with its exact quote. */
export function hostModelQuoteDigest(
  quote: Omit<HostModelQuoteObservationV1, "quoteDigest">,
): Sha256Digest {
  return parseSha256Digest(canonicalDigest({
    domain: "llmwiki-provider-model-quote-v1", ...quote,
  }));
}

function validModelQuote(
  quote: HostModelQuoteObservationV1, operation: HostModelOperationV1,
  payload: ModelPayload, requestDigest: Sha256Digest,
): boolean {
  const maximum = quote.inputTokens + quote.maximumOutputTokens;
  return Number.isSafeInteger(maximum)
    && quote.service === operation.service && quote.model === operation.model
    && quote.requestDigest === requestDigest && quote.inputTokens <= operation.maxInputTokens
    && quote.maximumOutputTokens === payload.maxOutputTokens
    && quote.maximumBillableTokens === maximum
    && quote.quoteDigest === hostModelQuoteDigest({
      service: quote.service, model: quote.model, requestDigest: quote.requestDigest,
      inputTokens: quote.inputTokens, maximumOutputTokens: quote.maximumOutputTokens,
      maximumBillableTokens: quote.maximumBillableTokens,
    });
}

function captureQuote(value: unknown): HostModelQuoteObservationV1 {
  const quote = captureExactRecord(value, [
    "service", "model", "requestDigest", "quoteDigest", "inputTokens",
    "maximumOutputTokens", "maximumBillableTokens",
  ]);
  if (typeof quote.service !== "string" || typeof quote.model !== "string") throw unavailableError();
  return Object.freeze({
    service: quote.service, model: quote.model,
    requestDigest: parseSha256Digest(quote.requestDigest), quoteDigest: parseSha256Digest(quote.quoteDigest),
    inputTokens: exactTokens(quote.inputTokens),
    maximumOutputTokens: exactTokens(quote.maximumOutputTokens),
    maximumBillableTokens: exactTokens(quote.maximumBillableTokens),
  });
}

function captureObservation(value: unknown): HostModelInvocationObservationV1 {
  const observed = captureExactRecord(value, [
    "service", "model", "requestDigest", "quoteDigest", "output",
    "inputTokens", "outputTokens", "billableTokens",
  ]);
  if (typeof observed.service !== "string" || typeof observed.model !== "string"
    || typeof observed.output !== "string" || Buffer.byteLength(observed.output) > 4 * 1024 * 1024) {
    throw unavailableError();
  }
  return Object.freeze({
    service: observed.service, model: observed.model, output: observed.output,
    requestDigest: parseSha256Digest(observed.requestDigest),
    quoteDigest: parseSha256Digest(observed.quoteDigest),
    inputTokens: exactTokens(observed.inputTokens), outputTokens: exactTokens(observed.outputTokens),
    billableTokens: exactTokens(observed.billableTokens),
  });
}

function exactTokens(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw unavailableError();
  return Number(value);
}

const response = brokerFailure;
function reservedResponse(outcome: "refused" | "unavailable", reason: string): HostBrokerExecutionV1 {
  return brokerFailure(outcome, reason, true);
}

/** Shared unavailable error for the model broker's front and execution halves. */
export function unavailableError(): Error { return new Error("provider model broker is unavailable"); }

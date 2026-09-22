/**
 * @file src/capability-providers/brokers/model.ts
 * @description Host model broker adapter over the existing LLMProvider. Exact
 * host-owned usage accounting and a digest-pinned active price are required
 * before any model call; the legacy provider interface alone cannot authorize
 * a zero-cost or unmetered invocation.
 */
import { captureDenseArray, captureExactRecord } from "../../utils/runtime-capture.js";
import type { LLMMessage, LLMProvider, LLMTool } from "../../utils/provider.js";
import type { EffectPlanEntryV1, ProviderAuthorityAtomV1 } from "../authority/types.js";
import type { AuthorizedProviderPaths } from "../packages/paths.js";
import { parseBrokerId } from "../ids.js";
import type { Sha256Digest } from "../types.js";
import type {
  BrokerJsonObjectV1, BrokerRequestEnvelopeV1, HostBrokerExecutionContextV1,
  PreparedHostBrokerCallV1,
} from "./types.js";
import { brokerRequestDigest } from "./types.js";
import { executeModel, unavailableError } from "./model-execution.js";
export { hostModelQuoteDigest } from "./model-execution.js";

export interface HostModelOperationV1 {
  readonly operationId: string;
  readonly targetIdentity: string;
  readonly service: string;
  readonly model: string;
  readonly mode: "complete" | "tool-call";
  readonly maxPromptBytes: number;
  readonly maxContextItems: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly priceUnit: string;
  readonly timeoutMs: number;
}

/** One exact host-owned non-billable preflight quote request. */
export interface HostModelQuoteRequestV1 {
  readonly service: string;
  readonly model: string;
  readonly mode: "complete" | "tool-call";
  readonly system: string;
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly LLMTool[];
  readonly maximumOutputTokens: number;
  readonly requestDigest: Sha256Digest;
  readonly signal: AbortSignal;
}

/** Request-bound host quote used as the exact invocation reservation. */
export interface HostModelQuoteObservationV1 {
  readonly service: string;
  readonly model: string;
  readonly requestDigest: Sha256Digest;
  readonly quoteDigest: Sha256Digest;
  readonly inputTokens: number;
  readonly maximumOutputTokens: number;
  readonly maximumBillableTokens: number;
}

/** One bounded host-owned invocation request over an already accepted quote. */
export interface HostModelInvocationRequestV1 {
  readonly service: string;
  readonly model: string;
  readonly mode: "complete" | "tool-call";
  readonly system: string;
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly LLMTool[];
  readonly requestDigest: Sha256Digest;
  readonly quoteDigest: Sha256Digest;
  readonly exactInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly maximumBillableTokens: number;
  readonly maximumCostUsd: number;
  readonly signal: AbortSignal;
}

/** Identity and exact billable usage observed from the same model response. */
export interface HostModelInvocationObservationV1 {
  readonly service: string;
  readonly model: string;
  readonly requestDigest: Sha256Digest;
  readonly quoteDigest: Sha256Digest;
  readonly output: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly billableTokens: number;
}

export interface HostModelBrokerV1 {
  readonly provider: LLMProvider;
  readonly operations: readonly HostModelOperationV1[];
  readonly quote?: (
    request: HostModelQuoteRequestV1,
  ) => Promise<HostModelQuoteObservationV1>;
  readonly invoke?: (
    request: HostModelInvocationRequestV1,
  ) => Promise<HostModelInvocationObservationV1>;
}

export interface ModelContext {
  readonly paths: AuthorizedProviderPaths;
  readonly priceTableDigest: Sha256Digest | null;
  readonly now: Date;
}

/** Capture one model call and bind it to a host-selected provider/model. */
export function prepareModelBroker(
  envelope: BrokerRequestEnvelopeV1,
  broker: HostModelBrokerV1 | undefined,
  context: ModelContext,
): PreparedHostBrokerCallV1 {
  if (!broker) throw unavailableError();
  const payload = capturePayload(envelope.payload);
  const operation = requireOperation(broker.operations, payload.operation);
  validatePrompt(operation, payload);
  const requestDigest = brokerRequestDigest(envelope);
  return Object.freeze({
    authority: Object.freeze([modelAuthority(operation)]), credentialSlotId: null,
    credentialOperation: null,
    category: "model", effect: null,
    execute: async (_secret: Buffer | null, _effect: EffectPlanEntryV1 | null,
      execution: HostBrokerExecutionContextV1) => executeModel(
      broker, operation, payload, requestDigest, context, execution,
    ),
  });
}

export interface ModelPayload {
  readonly operation: string;
  readonly system: string;
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly LLMTool[];
  readonly maxOutputTokens: number;
}

function capturePayload(value: BrokerJsonObjectV1): ModelPayload {
  try {
    const payload = captureExactRecord(value, ["operation", "system", "messages", "tools", "maxOutputTokens"]);
    if (typeof payload.operation !== "string" || typeof payload.system !== "string") throw new Error();
    const messages = captureDenseArray(payload.messages, 4_096, captureMessage, requestError);
    const tools = payload.tools === null
      ? Object.freeze([]) : captureDenseArray(payload.tools, 256, captureTool, requestError);
    if (!Number.isSafeInteger(payload.maxOutputTokens) || Number(payload.maxOutputTokens) <= 0) throw new Error();
    return Object.freeze({
      operation: payload.operation, system: payload.system, messages, tools,
      maxOutputTokens: Number(payload.maxOutputTokens),
    });
  } catch { throw requestError(); }
}

function captureMessage(value: unknown): LLMMessage {
  const message = captureExactRecord(value, ["role", "content"]);
  if ((message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") throw requestError();
  return Object.freeze({ role: message.role, content: message.content });
}

function captureTool(value: unknown): LLMTool {
  const tool = captureExactRecord(value, ["name", "description", "input_schema"]);
  if (typeof tool.name !== "string" || typeof tool.description !== "string"
    || typeof tool.input_schema !== "object" || tool.input_schema === null
    || Array.isArray(tool.input_schema)) throw requestError();
  return Object.freeze({
    name: tool.name, description: tool.description,
    input_schema: tool.input_schema as Record<string, unknown>,
  });
}

function requireOperation(
  operations: readonly HostModelOperationV1[], operationId: string,
): HostModelOperationV1 {
  const matches = operations.filter((operation) => operation.operationId === operationId);
  if (matches.length !== 1) throw requestError();
  const operation = matches[0];
  if (![operation.maxPromptBytes, operation.maxContextItems, operation.maxInputTokens,
    operation.maxOutputTokens, operation.timeoutMs].every((value) =>
    Number.isSafeInteger(value) && value > 0)) throw requestError();
  return operation;
}

function validatePrompt(operation: HostModelOperationV1, payload: ModelPayload): void {
  const bytes = Buffer.byteLength(payload.system)
    + payload.messages.reduce((total, message) => total + Buffer.byteLength(message.content), 0)
    + Buffer.byteLength(JSON.stringify(payload.tools));
  if (bytes > operation.maxPromptBytes || payload.messages.length > operation.maxContextItems
    || payload.maxOutputTokens > operation.maxOutputTokens
    || (operation.mode === "complete" && payload.tools.length !== 0)
    || (operation.mode === "tool-call" && payload.tools.length === 0)) throw requestError();
}

function modelAuthority(operation: HostModelOperationV1): ProviderAuthorityAtomV1 {
  return Object.freeze({
    kind: "model.invoke", brokerId: parseBrokerId("model"), operation: operation.operationId,
    target: operation.targetIdentity, method: null, credentialSlotId: null,
    credentialHandleId: null, effectClass: null, inputKind: null, toolId: null,
  });
}

function requestError(): Error { return new Error("provider model broker request is invalid"); }

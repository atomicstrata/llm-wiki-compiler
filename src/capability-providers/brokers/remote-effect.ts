/**
 * @file src/capability-providers/brokers/remote-effect.ts
 * @description Generic and remote-effect mutation broker primitives. Every
 * execution receives only a host-matched effect-plan idempotency key and maps
 * ambiguous adapter throws to outcome-unknown so a transmitted mutation is
 * never retried blindly.
 */
import { captureExactRecord, captureOwnDataRecord } from "../../utils/runtime-capture.js";
import { parseBrokerId, parseSha256Digest } from "../ids.js";
import type {
  EffectPlanEntryV1, ProviderAuthorityAtomV1, ProviderGrantKindV1,
} from "../authority/types.js";
import type { BrokerIdV1 } from "../types.js";
import type {
  BrokerJsonObjectV1, BrokerRequestEnvelopeV1, HostBrokerExecutionContextV1,
  HostBrokerExecutionV1, HostExternalEffectObservationV1, PreparedHostBrokerCallV1,
} from "./types.js";
import { brokerRequestDigest, captureBrokerJsonObject } from "./types.js";
import type { HostInvocationDeadlineV1 } from "./deadline.js";
import {
  credentialReflectionChunks, MAX_BROKER_CREDENTIAL_BYTES,
} from "./https.js";

export interface HostRemoteEffectOperationV1 {
  readonly operationId: string;
  readonly targetIdentity: string;
  readonly effectClass: string;
  readonly credentialSlotId?: string;
  readonly parameters: readonly HostMutationParameterV1[];
}

/** Closed scalar field admitted by a host mutation operation. */
export interface HostMutationParameterV1 {
  readonly name: string;
  readonly type: "string" | "integer" | "boolean";
  readonly maxStringBytes?: number;
}

export interface HostMutationExecutionRequestV1 {
  readonly operationId: string;
  readonly targetIdentity: string;
  readonly parameters: BrokerJsonObjectV1;
  readonly idempotencyKey: string;
  readonly credential: Buffer | null;
  readonly signal: AbortSignal;
}

export type HostMutationExecutorV1 = (
  request: HostMutationExecutionRequestV1,
) => Promise<HostExternalEffectObservationV1>;

export interface HostRemoteEffectBrokerV1 {
  readonly operations: readonly HostRemoteEffectOperationV1[];
  execute: HostMutationExecutorV1;
}

interface MutationOperation {
  readonly operationId: string;
  readonly targetIdentity: string;
  readonly effectClass: string;
  readonly credentialSlotId?: string;
  readonly parameters: readonly HostMutationParameterV1[];
}

interface MutationPreparation {
  readonly envelope: BrokerRequestEnvelopeV1;
  readonly brokerId: BrokerIdV1;
  readonly grantKind: ProviderGrantKindV1;
  readonly category: "scheduler" | "email" | "remote-effect";
  readonly operation: MutationOperation;
  readonly parameters: BrokerJsonObjectV1;
  readonly execute: HostMutationExecutorV1;
}

/** Capture one generic remote mutation selected from host definitions. */
export function prepareRemoteEffectBroker(
  envelope: BrokerRequestEnvelopeV1,
  broker: HostRemoteEffectBrokerV1 | undefined,
): PreparedHostBrokerCallV1 {
  if (!broker) throw unavailableError();
  const payload = captureExactRecord(envelope.payload, ["operation", "parameters"]);
  if (typeof payload.operation !== "string") throw requestError();
  const operation = exactOperation(broker.operations, payload.operation);
  return prepareMutation({
    envelope, brokerId: parseBrokerId("remote-effect"), grantKind: "external.mutate",
    category: "remote-effect", operation,
    parameters: captureMutationParameters(payload.parameters, operation.parameters),
    execute: broker.execute,
  });
}

/** Shared preparation used only by the closed scheduler and email wrappers. */
export function prepareMutation(input: MutationPreparation): PreparedHostBrokerCallV1 {
  return Object.freeze({
    authority: Object.freeze([mutationAuthority(input)]),
    credentialSlotId: input.operation.credentialSlotId ?? null,
    credentialOperation: input.operation.credentialSlotId ? input.operation.operationId : null,
    category: input.category,
    effect: Object.freeze({
      effectClass: input.operation.effectClass, targetIdentity: input.operation.targetIdentity,
      requestDigest: brokerRequestDigest(
        input.envelope, captureBrokerJsonObject(input.operation),
      ),
      expectedBounds: Object.freeze({ requests: 1 }),
    }),
    execute: async (secret: Buffer | null, effect: EffectPlanEntryV1 | null,
      context: HostBrokerExecutionContextV1) => executeMutation(input, secret, effect, context.deadline),
  });
}

/** Require one unique exact operation from a host-owned closed definition set. */
export function exactOperation<T extends MutationOperation>(
  operations: readonly T[], operationId: string,
): T {
  const matches = operations.filter((operation) => operation.operationId === operationId);
  if (matches.length !== 1) throw requestError();
  return matches[0];
}

/** Capture an exact closed scalar mutation parameter object. */
export function captureMutationParameters(
  value: unknown, schema: readonly HostMutationParameterV1[],
): BrokerJsonObjectV1 {
  const definitions = captureParameterDefinitions(schema);
  const record = captureOwnDataRecord(value);
  if (Object.keys(record).length !== definitions.length
    || definitions.some((definition) => !Object.hasOwn(record, definition.name))) {
    throw new Error("provider mutation parameters are invalid");
  }
  const result = Object.create(null) as Record<string, string | number | boolean>;
  for (const definition of definitions) {
    result[definition.name] = captureParameterValue(record[definition.name], definition);
  }
  return Object.freeze(result);
}

function captureParameterDefinitions(
  value: readonly HostMutationParameterV1[],
): readonly HostMutationParameterV1[] {
  const definitions = value.map(captureParameterDefinition);
  if (new Set(definitions.map((item) => item.name)).size !== definitions.length) throw requestError();
  return Object.freeze(definitions);
}

function captureParameterDefinition(item: unknown): HostMutationParameterV1 {
  const definition = captureOwnDataRecord(item);
  if (!validParameterDefinitionIdentity(definition)) throw requestError();
  const maximum = definition.maxStringBytes;
  if (!validParameterMaximum(definition.type, maximum)) throw requestError();
  return Object.freeze({ name: definition.name, type: definition.type,
    ...(maximum === undefined ? {} : { maxStringBytes: Number(maximum) }) });
}

function validParameterDefinitionIdentity(
  value: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, unknown>> & { name: string; type: HostMutationParameterV1["type"] } {
  const allowed = new Set(["name", "type", "maxStringBytes"]);
  return !Object.keys(value).some((key) => !allowed.has(key))
    && typeof value.name === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(value.name)
    && isParameterType(value.type);
}

function validParameterMaximum(
  type: HostMutationParameterV1["type"], value: unknown,
): boolean {
  return type === "string" ? validStringMaximum(value) : value === undefined;
}

function isParameterType(value: unknown): value is HostMutationParameterV1["type"] {
  return value === "string" || value === "integer" || value === "boolean";
}
function validStringMaximum(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 65_536;
}

function captureParameterValue(
  value: unknown, definition: HostMutationParameterV1,
): string | number | boolean {
  if (definition.type === "string") {
    if (typeof value !== "string" || Buffer.byteLength(value) > definition.maxStringBytes!
      || value.includes("\0")) throw new Error("provider mutation parameters are invalid");
    return value;
  }
  if (definition.type === "integer") {
    if (!Number.isSafeInteger(value)) throw new Error("provider mutation parameters are invalid");
    return Number(value);
  }
  if (typeof value !== "boolean") throw new Error("provider mutation parameters are invalid");
  return value;
}

function mutationAuthority(input: MutationPreparation): ProviderAuthorityAtomV1 {
  return Object.freeze({
    kind: input.grantKind, brokerId: input.brokerId, operation: input.operation.operationId,
    target: input.operation.targetIdentity, method: null, credentialSlotId: null,
    credentialHandleId: null, effectClass: input.operation.effectClass,
    inputKind: null, toolId: null,
  });
}

/**
 * The sole mutation executor behind `remote-effect`, `email`, and `scheduler`.
 *
 * The deadline is RE-READ here rather than trusted from dispatch. The central
 * gate runs before the settled-effect lookup, the credential read, and the
 * durable effect claim — every one of them an await — so a budget that survived
 * that gate can be spent by the time this executor runs. Because outbound
 * transmission is what these brokers do, that interval is exactly where an
 * expired deadline must not be allowed to leak into a real external effect.
 */
async function executeMutation(
  input: MutationPreparation, secret: Buffer | null, effect: EffectPlanEntryV1 | null,
  deadline: HostInvocationDeadlineV1,
): Promise<HostBrokerExecutionV1> {
  if (!effect) return result("refused", { reason: "effect plan entry is unavailable" });
  // REFUSED, not outcome-unknown: nothing has been transmitted, so the effect is
  // known NOT to have happened. Reporting uncertainty would strand a settleable
  // effect in the unresolved state for no reason.
  if (deadline.expired()) {
    return result("refused", {
      reason: "mutating effect refused after the invocation wall-time deadline before transmission",
    });
  }
  if (secret && secret.length > MAX_BROKER_CREDENTIAL_BYTES) {
    return result("refused", { reason: "credential cannot be safely reflected-scanned" });
  }
  let observation: HostExternalEffectObservationV1;
  const adapterCredential = secret ? Buffer.from(secret) : null;
  try {
    observation = await input.execute(Object.freeze({
      operationId: input.operation.operationId, targetIdentity: input.operation.targetIdentity,
      parameters: input.parameters, idempotencyKey: effect.idempotencyKey,
      credential: adapterCredential, signal: deadline.signal,
    }));
  } catch {
    observation = Object.freeze({ outcome: "outcome-unknown" });
  } finally { adapterCredential?.fill(0); }
  return observationResult(observation, secret);
}

function observationResult(
  observation: HostExternalEffectObservationV1,
  secret: Buffer | null,
): HostBrokerExecutionV1 {
  const captured = captureExternalEffectObservation(observation);
  const output = captured.output ?? Object.freeze({ outcome: captured.outcome });
  const visible = Buffer.from(JSON.stringify(output));
  return Object.freeze({
    outcome: captured.outcome, output,
    visibleBytes: secret
      ? credentialReflectionChunks(visible, secret.length) : Object.freeze([visible]),
    ...(captured.observedExternalIdentity ? {
      observedExternalIdentity: captured.observedExternalIdentity,
    } : {}),
    ...(captured.responseDigest ? {
      responseDigest: captured.responseDigest,
    } : {}),
  });
}

/** Capture one mutating adapter observation exactly once after host I/O. */
export function captureExternalEffectObservation(value: unknown): HostExternalEffectObservationV1 {
  const record = captureOwnDataRecord(value);
  const allowed = new Set(["outcome", "observedExternalIdentity", "responseDigest", "output"]);
  if (!Object.hasOwn(record, "outcome")
    || Object.keys(record).some((key) => !allowed.has(key))) throw requestError();
  const outcome = record.outcome;
  if (outcome !== "applied" && outcome !== "already-applied" && outcome !== "refused"
    && outcome !== "failed" && outcome !== "unavailable" && outcome !== "outcome-unknown") {
    throw requestError();
  }
  const identity = optionalIdentity(record.observedExternalIdentity);
  const digest = record.responseDigest === undefined
    ? undefined : parseSha256Digest(record.responseDigest);
  const output = record.output === undefined ? undefined : captureBrokerJsonObject(record.output);
  return Object.freeze({ outcome, ...(identity === undefined ? {} : {
    observedExternalIdentity: identity,
  }), ...(digest === undefined ? {} : { responseDigest: digest }),
  ...(output === undefined ? {} : { output }) });
}

function optionalIdentity(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 4_096
    || /[\u0000-\u001f\u007f]/.test(value)) throw requestError();
  return value;
}

function result(
  outcome: "refused" | "unavailable", output: BrokerJsonObjectV1,
): HostBrokerExecutionV1 {
  return Object.freeze({ outcome, output, visibleBytes: Object.freeze([Buffer.from(JSON.stringify(output))]) });
}
function requestError(): Error { return new Error("provider remote-effect broker request is invalid"); }
function unavailableError(): Error { return new Error("provider remote-effect broker is unavailable"); }

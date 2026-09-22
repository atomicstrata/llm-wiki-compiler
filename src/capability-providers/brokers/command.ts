/**
 * @file src/capability-providers/brokers/command.ts
 * @description Compiled-in command broker contracts. A provider supplies only
 * values for a closed typed argv schema; the host chooses an absolute
 * executable, constructs an argv vector, disables shells and inherited input,
 * supplies an allowlisted environment, and bounds all provider-visible bytes.
 */
import path from "node:path";
import { TextDecoder } from "node:util";
import { types as utilTypes } from "node:util";
import { captureExactRecord, captureOwnDataRecord } from "../../utils/runtime-capture.js";
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { parseBrokerId, parseSha256Digest } from "../ids.js";
import {
  MAX_COMMAND_AGGREGATE_ACCEPTED_BYTES, MAX_COMMAND_WALL_TIME_MS,
} from "../constants.js";
import type { EffectPlanEntryV1, ProviderAuthorityAtomV1 } from "../authority/types.js";
import type {
  BrokerJsonObjectV1, BrokerRequestEnvelopeV1, HostBrokerBudgetV1,
  HostBrokerExecutionContextV1, HostBrokerExecutionV1, HostExternalEffectObservationV1,
  PreparedHostBrokerCallV1,
} from "./types.js";
import { brokerFailure, brokerRequestDigest, captureBrokerJsonObject } from "./types.js";
import {
  credentialReflectionChunks, MAX_BROKER_CREDENTIAL_BYTES, MAX_CREDENTIAL_VISIBLE_BYTES,
} from "./https.js";
import { captureExternalEffectObservation } from "./remote-effect.js";

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const COMMAND_OUTPUT_EXCEEDED = Symbol("command-output-exceeded");

export interface HostCommandArgumentV1 {
  readonly name: string;
  readonly flag: string;
  readonly type: "string" | "integer" | "boolean";
  readonly maxStringBytes?: number;
}

export interface HostCommandOperationV1 {
  readonly operationId: string;
  readonly targetIdentity: string;
  readonly toolId: string;
  readonly executable: string;
  readonly arguments: readonly HostCommandArgumentV1[];
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxAcceptedBytes: number;
  readonly credential?: { readonly slotId: string; readonly environmentName: string };
  readonly effect?: { readonly effectClass: string; readonly targetIdentity: string };
}

export interface HostCommandRunRequestV1 {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly stdin: null;
  readonly timeoutMs: number;
  readonly maxAcceptedBytes: number;
  readonly idempotencyKey: string | null;
  readonly workingDirectoryToken: string;
  readonly descriptorPolicy: "closed";
  readonly interactionPolicy: "noninteractive";
  readonly deadlinePolicy: "terminate-process-tree";
  readonly signal: AbortSignal;
}

export interface HostCommandRunObservationV1 {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly effect?: HostExternalEffectObservationV1;
}

export interface HostCommandBrokerV1 {
  readonly workingDirectoryToken: string;
  readonly operations: readonly HostCommandOperationV1[];
  run(request: HostCommandRunRequestV1): Promise<HostCommandRunObservationV1>;
}

interface CommandExecutionPreparation {
  readonly maximum: number;
  readonly environment: Record<string, string>;
}

/** Capture a typed command request and construct no shell string or path. */
export function prepareCommandBroker(
  envelope: BrokerRequestEnvelopeV1,
  broker: HostCommandBrokerV1 | undefined,
): PreparedHostBrokerCallV1 {
  if (!broker) throw unavailableError();
  const workingDirectoryToken = confinedDirectoryToken(broker.workingDirectoryToken);
  const payload = capturePayload(envelope.payload);
  const operation = requireOperation(broker.operations, payload.operation);
  const argv = captureArguments(payload.arguments, operation.arguments);
  return Object.freeze({
    authority: Object.freeze([commandAuthority(operation), ...effectAuthority(operation)]),
    credentialSlotId: operation.credential?.slotId ?? null,
    credentialOperation: operation.credential ? operation.operationId : null,
    category: "command",
    effect: operation.effect ? Object.freeze({
      ...operation.effect, requestDigest: brokerRequestDigest(
        envelope, captureBrokerJsonObject(operation),
      ),
      expectedBounds: Object.freeze({ requests: 1 }),
    }) : null,
    execute: async (secret: Buffer | null, effect: EffectPlanEntryV1 | null,
      context: HostBrokerExecutionContextV1) => executeCommand(
      broker, operation, argv, workingDirectoryToken, secret, effect, context,
    ),
  });
}

function capturePayload(value: BrokerJsonObjectV1): { operation: string; arguments: unknown } {
  try {
    const payload = captureExactRecord(value, ["operation", "arguments"]);
    if (typeof payload.operation !== "string") throw new Error();
    return { operation: payload.operation, arguments: payload.arguments };
  } catch { throw requestError(); }
}

function requireOperation(
  operations: readonly HostCommandOperationV1[], operationId: string,
): HostCommandOperationV1 {
  const matches = operations.filter((operation) => operation.operationId === operationId);
  if (matches.length !== 1) throw requestError();
  const operation = matches[0];
  if (!validCommandOperation(operation)) throw requestError();
  return operation;
}

function validCommandOperation(operation: HostCommandOperationV1): boolean {
  if (!path.isAbsolute(operation.executable) || operation.executable.includes("\0")) return false;
  if (operation.arguments.some((argument) => !safeArgumentDefinition(argument))) return false;
  return positiveInteger(operation.timeoutMs) && operation.timeoutMs <= MAX_COMMAND_WALL_TIME_MS
    && nonnegativeInteger(operation.maxAcceptedBytes)
    && operation.maxAcceptedBytes <= MAX_COMMAND_AGGREGATE_ACCEPTED_BYTES;
}

function captureArguments(value: unknown, schema: readonly HostCommandArgumentV1[]): readonly string[] {
  try {
    const values = captureOwnDataRecord(value);
    if (Object.keys(values).length !== schema.length
      || schema.some((argument) => !(argument.name in values))) throw new Error();
    return Object.freeze(schema.map((argument) => `${argument.flag}=${argumentValue(values[argument.name], argument)}`));
  } catch { throw requestError(); }
}

function argumentValue(value: unknown, argument: HostCommandArgumentV1): string {
  if (argument.type === "string") {
    if (typeof value !== "string" || Buffer.byteLength(value) > (argument.maxStringBytes ?? 4_096)
      || value.includes("\0")) throw requestError();
    return value;
  }
  if (argument.type === "integer") {
    if (!Number.isSafeInteger(value)) throw requestError();
    return String(value);
  }
  if (typeof value !== "boolean") throw requestError();
  return String(value);
}

function safeArgumentDefinition(argument: HostCommandArgumentV1): boolean {
  return /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(argument.name)
    && /^--[A-Za-z][A-Za-z0-9-]{0,63}$/.test(argument.flag);
}

function commandAuthority(operation: HostCommandOperationV1): ProviderAuthorityAtomV1 {
  return Object.freeze({
    kind: "command.execute", brokerId: parseBrokerId("command"),
    operation: operation.operationId, target: operation.targetIdentity, method: null,
    credentialSlotId: null, credentialHandleId: null, effectClass: null,
    inputKind: null, toolId: operation.toolId,
  });
}

function effectAuthority(operation: HostCommandOperationV1): ProviderAuthorityAtomV1[] {
  if (!operation.effect) return [];
  return [Object.freeze({
    kind: "external.mutate", brokerId: parseBrokerId("command"),
    operation: operation.operationId, target: operation.effect.targetIdentity, method: null,
    credentialSlotId: null, credentialHandleId: null, effectClass: operation.effect.effectClass,
    inputKind: null, toolId: null,
  })];
}

async function executeCommand(
  broker: HostCommandBrokerV1, operation: HostCommandOperationV1, argv: readonly string[],
  workingDirectoryToken: string, secret: Buffer | null,
  effect: EffectPlanEntryV1 | null, context: HostBrokerExecutionContextV1,
): Promise<HostBrokerExecutionV1> {
  if (context.deadline.expired()) {
    return operation.effect ? reservedUnknownResponse()
      : response("unavailable", "registered command exceeded the invocation deadline");
  }
  const prepared = prepareCommandExecution(operation, secret, context.budget, context.reserve);
  if ("outcome" in prepared) return prepared;
  const observed = await runRegisteredCommand(
    broker, operation, argv, workingDirectoryToken,
    prepared.environment, prepared.maximum, effect, context.deadline.signal,
  );
  if (observed === COMMAND_OUTPUT_EXCEEDED) {
    return reservedResponse("refused", "registered command exceeded its accepted-byte cap");
  }
  if (!observed) return operation.effect
    ? reservedUnknownResponse() : reservedResponse("unavailable", "registered command is unavailable");
  return Object.freeze({
    ...commandObservation(observed, operation, prepared.maximum, secret), usageReserved: true,
  });
}

function prepareCommandExecution(
  operation: HostCommandOperationV1, secret: Buffer | null, budget: HostBrokerBudgetV1,
  reserve: (usage: import("./types.js").HostBrokerUsageV1) => boolean,
): CommandExecutionPreparation | HostBrokerExecutionV1 {
  if (secret && secret.length > MAX_BROKER_CREDENTIAL_BYTES) {
    return response("refused", "credential cannot be safely reflected-scanned");
  }
  const maximum = Math.min(operation.maxAcceptedBytes, budget.commandAcceptedBytes,
    secret ? MAX_CREDENTIAL_VISIBLE_BYTES : Number.MAX_SAFE_INTEGER);
  if (maximum <= 0 || !reserve({ commandAcceptedBytes: maximum })) {
    return response("refused", "command byte cap is exhausted");
  }
  const captured = commandEnvironment(operation, secret);
  return "outcome" in captured ? captured : { maximum, environment: captured.environment };
}

function commandEnvironment(
  operation: HostCommandOperationV1, secret: Buffer | null,
): { readonly environment: Record<string, string> } | HostBrokerExecutionV1 {
  const environment = captureEnvironment(operation.environment);
  if (operation.credential && !secret) return response("unavailable", "broker credential is unavailable");
  if (operation.credential && secret) {
    environment[operation.credential.environmentName] = strictSecret(secret);
  }
  return { environment };
}

async function runRegisteredCommand(
  broker: HostCommandBrokerV1, operation: HostCommandOperationV1, argv: readonly string[],
  workingDirectoryToken: string, environment: Record<string, string>,
  maximum: number, effect: EffectPlanEntryV1 | null, deadline: AbortSignal,
): Promise<HostCommandRunObservationV1 | typeof COMMAND_OUTPUT_EXCEEDED | null> {
  try {
    return captureRunObservation(await broker.run(Object.freeze({
      executable: operation.executable, argv, environment: Object.freeze(environment),
      shell: false, stdin: null, timeoutMs: operation.timeoutMs, maxAcceptedBytes: maximum,
      idempotencyKey: effect?.idempotencyKey ?? null,
      workingDirectoryToken, descriptorPolicy: "closed",
      interactionPolicy: "noninteractive", deadlinePolicy: "terminate-process-tree",
      signal: deadline,
    })), maximum);
  } catch { return null; }
}

function confinedDirectoryToken(value: unknown): string {
  if (typeof value !== "string" || !/^cwd-[A-Za-z0-9._:-]{1,252}$/.test(value)) {
    throw requestError();
  }
  return value;
}

function commandObservation(
  observed: HostCommandRunObservationV1, operation: HostCommandOperationV1,
  maximum: number, secret: Buffer | null,
): HostBrokerExecutionV1 {
  const stdout = Buffer.from(observed.stdout), stderr = Buffer.from(observed.stderr);
  if (!Number.isSafeInteger(observed.exitCode) || stdout.length + stderr.length > maximum) {
    return response("refused", "registered command exceeded its accepted-byte cap");
  }
  let stdoutText: string, stderrText: string;
  try { stdoutText = STRICT_UTF8.decode(stdout); stderrText = STRICT_UTF8.decode(stderr); }
  catch { return response("refused", "registered command output is not valid UTF-8"); }
  const output = Object.freeze({ exitCode: observed.exitCode, stdout: stdoutText, stderr: stderrText });
  if (!operation.effect && observed.exitCode !== 0) return Object.freeze({ outcome: "failed", output });
  if (operation.effect) return effectObservation(
    observed.effect, output, stdout, stderr, secret, maximum,
  );
  return successfulCommand(output, stdout, stderr, secret);
}

function effectObservation(
  effect: HostExternalEffectObservationV1 | undefined, output: BrokerJsonObjectV1,
  stdout: Buffer, stderr: Buffer, secret: Buffer | null, maximum: number,
): HostBrokerExecutionV1 {
  const observation = effect === undefined
    ? { outcome: "outcome-unknown" as const }
    : captureExternalEffectObservation(effect);
  const observedOutput = observation.output ?? output;
  const extra = observation.output ? Buffer.from(JSON.stringify(observation.output)) : Buffer.alloc(0);
  const exceeds = stdout.length + stderr.length + extra.length > maximum;
  return Object.freeze({
    outcome: observation.outcome,
    output: exceeds ? Object.freeze({ reason: "command effect output exceeded byte cap" }) : observedOutput,
    usage: Object.freeze({ commandAcceptedBytes: stdout.length + stderr.length }),
    visibleBytes: visibleCommandBytes(stdout, stderr, secret, exceeds ? undefined : extra),
    ...(observation.observedExternalIdentity ? { observedExternalIdentity: observation.observedExternalIdentity } : {}),
    ...(observation.responseDigest ? { responseDigest: parseSha256Digest(observation.responseDigest) } : {}),
  });
}

function captureRunObservation(
  value: unknown, maximum: number,
): HostCommandRunObservationV1 | typeof COMMAND_OUTPUT_EXCEEDED {
  const observed = captureOwnDataRecord(value);
  const allowed = new Set(["exitCode", "stdout", "stderr", "effect"]);
  if (!Object.hasOwn(observed, "exitCode") || !Object.hasOwn(observed, "stdout")
    || !Object.hasOwn(observed, "stderr")
    || Object.keys(observed).some((key) => !allowed.has(key))
    || !Number.isSafeInteger(observed.exitCode)) throw requestError();
  const stdout = acceptedBytes(observed.stdout), stderr = acceptedBytes(observed.stderr);
  if (stdout.byteLength > maximum || stderr.byteLength > maximum - stdout.byteLength) {
    return COMMAND_OUTPUT_EXCEEDED;
  }
  return Object.freeze({
    exitCode: Number(observed.exitCode), stdout: Buffer.from(stdout), stderr: Buffer.from(stderr),
    ...(observed.effect === undefined ? {} : {
      effect: captureExternalEffectObservation(observed.effect),
    }),
  });
}

function acceptedBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || utilTypes.isProxy(value)) throw requestError();
  return value;
}

function successfulCommand(
  output: BrokerJsonObjectV1, stdout: Buffer, stderr: Buffer, secret: Buffer | null,
): HostBrokerExecutionV1 {
  return Object.freeze({
    outcome: "ok", output,
    usage: Object.freeze({ commandAcceptedBytes: stdout.length + stderr.length }),
    visibleBytes: visibleCommandBytes(stdout, stderr, secret),
    responseDigest: parseSha256Digest(canonicalDigest(output)),
  });
}

function visibleCommandBytes(
  stdout: Buffer, stderr: Buffer, secret: Buffer | null, extra?: Buffer,
): readonly Buffer[] {
  const values = extra && extra.length ? [stdout, stderr, extra] : [stdout, stderr];
  if (!secret) return Object.freeze(values);
  return Object.freeze([
    ...values.flatMap((value) => credentialReflectionChunks(value, secret.length)),
  ]);
}

function captureEnvironment(value: Readonly<Record<string, string>>): Record<string, string> {
  const record = captureOwnDataRecord(value), result: Record<string, string> = {};
  for (const [name, item] of Object.entries(record)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name) || typeof item !== "string" || item.includes("\0")) throw requestError();
    result[name] = item;
  }
  return result;
}
function strictSecret(secret: Buffer): string {
  const text = STRICT_UTF8.decode(secret);
  if (text.includes("\0")) throw requestError();
  return text;
}
function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
function nonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
const response = brokerFailure;
function reservedResponse(outcome: "refused" | "unavailable", reason: string): HostBrokerExecutionV1 {
  return brokerFailure(outcome, reason, true);
}
function reservedUnknownResponse(): HostBrokerExecutionV1 {
  return Object.freeze({ outcome: "outcome-unknown", usageReserved: true,
    output: Object.freeze({ reason: "registered command outcome is unknown" }) });
}
function requestError(): Error { return new Error("provider command broker request is invalid"); }
function unavailableError(): Error { return new Error("provider command broker is unavailable"); }

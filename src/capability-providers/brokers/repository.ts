/**
 * @file src/capability-providers/brokers/repository.ts
 * @description Commit-pinned repository snapshot broker. Provider requests
 * select only a host-declared operation and its exact commit; the adapter
 * returns an opaque copied-snapshot token and host-observed bounded evidence,
 * never a ref, credential, config, hook, socket, or host repository path.
 */
import { captureExactRecord, captureOwnDataRecord } from "../../utils/runtime-capture.js";
import { parseBrokerId, parseSha256Digest } from "../ids.js";
import type { EffectPlanEntryV1, ProviderAuthorityAtomV1 } from "../authority/types.js";
import type { Sha256Digest } from "../types.js";
import type {
  BrokerCompletionEvidenceV1, BrokerJsonObjectV1, BrokerRequestEnvelopeV1,
  HostBrokerExecutionContextV1, HostBrokerExecutionV1, PreparedHostBrokerCallV1,
} from "./types.js";
import type { HostInvocationDeadlineV1 } from "./deadline.js";

export interface HostRepositoryOperationV1 {
  readonly operationId: string;
  readonly remoteIdentity: string;
  readonly commit: string;
  readonly maxObjectBytes: number;
  readonly maxCheckoutBytes: number;
  readonly maxFiles: number;
  readonly pathPrefixes: readonly string[];
  readonly submodules: "forbid";
  readonly lfs: "forbid";
}

export interface HostRepositorySnapshotObservationV1 {
  readonly snapshotToken: string;
  readonly remoteIdentity: string;
  readonly commit: string;
  readonly treeDigest: Sha256Digest;
  readonly objectBytes: number;
  readonly checkoutBytes: number;
  readonly fileCount: number;
  readonly submodules: "omitted";
  readonly lfs: "omitted";
  readonly hooksInstalled: false;
  readonly completion?: BrokerCompletionEvidenceV1;
}

export interface HostRepositoryBrokerV1 {
  readonly operations: readonly HostRepositoryOperationV1[];
  snapshot(
    operation: HostRepositoryOperationV1, signal: AbortSignal,
  ): Promise<HostRepositorySnapshotObservationV1>;
}

/** Capture an exact immutable repository request before adapter I/O. */
export function prepareRepositoryBroker(
  envelope: BrokerRequestEnvelopeV1,
  broker: HostRepositoryBrokerV1 | undefined,
): PreparedHostBrokerCallV1 {
  if (!broker) throw unavailableError();
  const payload = capturePayload(envelope.payload);
  const operation = requireOperation(broker.operations, payload.operation, payload.commit);
  return Object.freeze({
    authority: Object.freeze([repositoryAuthority(operation)]), credentialSlotId: null,
    credentialOperation: null,
    category: "repository", effect: null,
    execute: async (_secret: Buffer | null, _effect: EffectPlanEntryV1 | null,
      context: HostBrokerExecutionContextV1) => executeRepository(broker, operation, context.deadline),
  });
}

function capturePayload(value: BrokerJsonObjectV1): { operation: string; commit: string } {
  try {
    const payload = captureExactRecord(value, ["operation", "commit"]);
    if (typeof payload.operation !== "string" || typeof payload.commit !== "string"
      || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(payload.commit)) throw new Error();
    return { operation: payload.operation, commit: payload.commit };
  } catch { throw requestError(); }
}

function requireOperation(
  operations: readonly HostRepositoryOperationV1[], operationId: string, commit: string,
): HostRepositoryOperationV1 {
  const matches = operations.filter((operation) => operation.operationId === operationId
    && operation.commit === commit);
  if (matches.length !== 1) throw requestError();
  const operation = matches[0];
  if (operation.submodules !== "forbid" || operation.lfs !== "forbid"
    || operation.pathPrefixes.some((prefix) => !safePrefix(prefix))
    || !validOperationBounds(operation)) throw requestError();
  return operation;
}

function validOperationBounds(operation: HostRepositoryOperationV1): boolean {
  return [operation.maxObjectBytes, operation.maxCheckoutBytes, operation.maxFiles]
    .every((value) => Number.isSafeInteger(value) && value >= 0)
    && operation.maxObjectBytes <= operation.maxCheckoutBytes;
}

function repositoryAuthority(operation: HostRepositoryOperationV1): ProviderAuthorityAtomV1 {
  return Object.freeze({
    kind: "repository.snapshot", brokerId: parseBrokerId("repository"),
    operation: operation.operationId, target: operation.remoteIdentity, method: null,
    credentialSlotId: null, credentialHandleId: null, effectClass: null,
    inputKind: null, toolId: null,
  });
}

async function executeRepository(
  broker: HostRepositoryBrokerV1,
  operation: HostRepositoryOperationV1,
  deadline: HostInvocationDeadlineV1,
): Promise<HostBrokerExecutionV1> {
  if (deadline.expired()) return response("unavailable", "repository snapshot exceeded the invocation deadline");
  let observed: HostRepositorySnapshotObservationV1;
  try { observed = captureObservation(await broker.snapshot(operation, deadline.signal)); }
  catch { return response("unavailable", "repository snapshot is unavailable"); }
  if (!validObservation(observed, operation)) {
    return response("refused", "repository snapshot did not match the pinned commit or bounds");
  }
  const output = Object.freeze({
    snapshotToken: observed.snapshotToken, remoteIdentity: observed.remoteIdentity,
    commit: observed.commit, treeDigest: parseSha256Digest(observed.treeDigest),
    objectBytes: observed.objectBytes, checkoutBytes: observed.checkoutBytes,
    fileCount: observed.fileCount,
  });
  const responseDigest = parseSha256Digest(observed.treeDigest);
  if (isPartialCheckout(observed.completion)) {
    return Object.freeze({ outcome: "partial", output, responseDigest,
      completion: observed.completion });
  }
  return Object.freeze({ outcome: "ok", output, responseDigest });
}

function isPartialCheckout(
  completion: BrokerCompletionEvidenceV1 | undefined,
): completion is BrokerCompletionEvidenceV1 {
  return completion !== undefined && completion.completed < completion.attempted;
}

function captureObservation(value: unknown): HostRepositorySnapshotObservationV1 {
  const observed = captureOwnDataRecord(value);
  const required = ["snapshotToken", "remoteIdentity", "commit", "treeDigest", "objectBytes",
    "checkoutBytes", "fileCount", "submodules", "lfs", "hooksInstalled"];
  const allowed = new Set([...required, "completion"]);
  if (required.some((key) => !Object.hasOwn(observed, key))
    || Object.keys(observed).some((key) => !allowed.has(key))) throw requestError();
  return Object.freeze({
    snapshotToken: observed.snapshotToken as string,
    remoteIdentity: observed.remoteIdentity as string, commit: observed.commit as string,
    treeDigest: observed.treeDigest as Sha256Digest,
    objectBytes: observed.objectBytes as number, checkoutBytes: observed.checkoutBytes as number,
    fileCount: observed.fileCount as number,
    submodules: observed.submodules as "omitted", lfs: observed.lfs as "omitted",
    hooksInstalled: observed.hooksInstalled as false,
    ...(observed.completion === undefined ? {} : { completion: captureCompletion(observed.completion) }),
  });
}

function captureCompletion(value: unknown): BrokerCompletionEvidenceV1 {
  const record = captureExactRecord(value, ["completed", "attempted"]);
  const completed = record.completed, attempted = record.attempted;
  if (!Number.isSafeInteger(completed) || Number(completed) < 0
    || !Number.isSafeInteger(attempted) || Number(attempted) < 0
    || Number(completed) > Number(attempted)) throw requestError();
  return Object.freeze({ completed: Number(completed), attempted: Number(attempted) });
}

function validObservation(
  observed: HostRepositorySnapshotObservationV1,
  operation: HostRepositoryOperationV1,
): boolean {
  try {
    parseSha256Digest(observed.treeDigest);
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(observed.snapshotToken)
      && observed.remoteIdentity === operation.remoteIdentity
      && observed.commit === operation.commit
      && bounded(observed.objectBytes, operation.maxObjectBytes)
      && bounded(observed.checkoutBytes, operation.maxCheckoutBytes)
      && bounded(observed.fileCount, operation.maxFiles)
      && assertedPolicy(observed, operation);
  } catch { return false; }
}

/**
 * The adapter must positively assert it honored the broker contract's
 * submodule/LFS and hook policy; a snapshot that omits or contradicts the
 * assertion is refused rather than trusted.
 */
function assertedPolicy(
  observed: HostRepositorySnapshotObservationV1,
  operation: HostRepositoryOperationV1,
): boolean {
  return operation.submodules === "forbid" && observed.submodules === "omitted"
    && operation.lfs === "forbid" && observed.lfs === "omitted"
    && observed.hooksInstalled === false;
}

function bounded(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(maximum)
    && maximum >= 0 && value <= maximum;
}
function safePrefix(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !value.includes("..")
    && !value.includes("\\") && !value.includes("\0");
}
function response(outcome: "refused" | "unavailable", reason: string): HostBrokerExecutionV1 {
  return Object.freeze({ outcome, output: Object.freeze({ reason }) });
}
function requestError(): Error { return new Error("provider repository broker request is invalid"); }
function unavailableError(): Error { return new Error("provider repository broker is unavailable"); }

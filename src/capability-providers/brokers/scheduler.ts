/**
 * @file src/capability-providers/brokers/scheduler.ts
 * @description Closed scheduler mutation broker. Provider requests may select
 * only one predeclared job identity and bounded parameter object; the matched
 * effect-plan entry supplies the authoritative idempotency key.
 */
import { captureExactRecord } from "../../utils/runtime-capture.js";
import { parseBrokerId } from "../ids.js";
import type {
  BrokerJsonObjectV1, BrokerRequestEnvelopeV1, PreparedHostBrokerCallV1,
} from "./types.js";
import {
  captureMutationParameters, exactOperation, prepareMutation,
  type HostMutationExecutorV1, type HostMutationParameterV1,
} from "./remote-effect.js";

export interface HostSchedulerOperationV1 {
  readonly operationId: string;
  readonly jobId: string;
  readonly targetIdentity: string;
  readonly effectClass: string;
  readonly credentialSlotId?: string;
  readonly parameters: readonly HostMutationParameterV1[];
}

export interface HostSchedulerBrokerV1 {
  readonly operations: readonly HostSchedulerOperationV1[];
  execute: HostMutationExecutorV1;
}

/** Capture one scheduler request and reject unregistered job identities. */
export function prepareSchedulerBroker(
  envelope: BrokerRequestEnvelopeV1,
  broker: HostSchedulerBrokerV1 | undefined,
): PreparedHostBrokerCallV1 {
  if (!broker) throw new Error("provider scheduler broker is unavailable");
  const payload = captureExactRecord(envelope.payload, ["operation", "jobId", "parameters"]);
  if (typeof payload.operation !== "string" || typeof payload.jobId !== "string") throw requestError();
  const operation = exactOperation(broker.operations, payload.operation);
  if (operation.jobId !== payload.jobId) throw requestError();
  const parameters = captureMutationParameters(payload.parameters, operation.parameters);
  return prepareMutation({
    envelope, brokerId: parseBrokerId("scheduler"), grantKind: "scheduler.write",
    category: "scheduler", operation, parameters, execute: broker.execute,
  });
}

function requestError(): Error { return new Error("provider scheduler broker request is invalid"); }

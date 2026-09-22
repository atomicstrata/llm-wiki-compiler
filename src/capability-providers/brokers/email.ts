/**
 * @file src/capability-providers/brokers/email.ts
 * @description Closed email mutation broker. Providers cannot supply raw
 * recipients, bodies, or arbitrary templates: only predeclared recipient and
 * template identities plus inert template variables reach the host adapter.
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

export interface HostEmailOperationV1 {
  readonly operationId: string;
  readonly recipientId: string;
  readonly templateId: string;
  readonly targetIdentity: string;
  readonly effectClass: string;
  readonly credentialSlotId?: string;
  readonly parameters: readonly HostMutationParameterV1[];
}

export interface HostEmailBrokerV1 {
  readonly operations: readonly HostEmailOperationV1[];
  execute: HostMutationExecutorV1;
}

/** Capture one email request and enforce both predeclared identities. */
export function prepareEmailBroker(
  envelope: BrokerRequestEnvelopeV1,
  broker: HostEmailBrokerV1 | undefined,
): PreparedHostBrokerCallV1 {
  if (!broker) throw new Error("provider email broker is unavailable");
  const payload = captureExactRecord(
    envelope.payload, ["operation", "recipientId", "templateId", "variables"],
  );
  if (typeof payload.operation !== "string" || typeof payload.recipientId !== "string"
    || typeof payload.templateId !== "string") throw requestError();
  const operation = exactOperation(broker.operations, payload.operation);
  if (operation.recipientId !== payload.recipientId
    || operation.templateId !== payload.templateId) throw requestError();
  const parameters = captureMutationParameters(payload.variables, operation.parameters);
  return prepareMutation({
    envelope, brokerId: parseBrokerId("email"), grantKind: "email.send",
    category: "email", operation, parameters, execute: broker.execute,
  });
}

function requestError(): Error { return new Error("provider email broker request is invalid"); }

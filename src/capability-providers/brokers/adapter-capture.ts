/**
 * @file src/capability-providers/brokers/adapter-capture.ts
 * @description Defensive capture and drift comparison for host broker
 * adapters, retaining legacy model providers as opaque trusted identities.
 */
import { captureOwnDataRecord } from "../../utils/runtime-capture.js";
import { captureHostDefinition, sameHostDefinition } from "./host-capture.js";
import type { HostCommandBrokerV1 } from "./command.js";
import type { HostEmailBrokerV1 } from "./email.js";
import type { HostHttpsBrokerV1 } from "./https.js";
import type { HostModelBrokerV1 } from "./model.js";
import type { HostRemoteEffectBrokerV1 } from "./remote-effect.js";
import type { HostRepositoryBrokerV1 } from "./repository.js";
import type { HostSchedulerBrokerV1 } from "./scheduler.js";

export interface HostBrokerAdaptersV1 {
  readonly https?: HostHttpsBrokerV1;
  readonly model?: HostModelBrokerV1;
  readonly repository?: HostRepositoryBrokerV1;
  readonly command?: HostCommandBrokerV1;
  readonly scheduler?: HostSchedulerBrokerV1;
  readonly email?: HostEmailBrokerV1;
  readonly "remote-effect"?: HostRemoteEffectBrokerV1;
}

export interface CapturedHostBrokerAdaptersV1 {
  readonly brokers: HostBrokerAdaptersV1;
  readonly opaque: ReadonlySet<object>;
}

const BROKER_KEYS = new Set([
  "https", "model", "repository", "command", "scheduler", "email", "remote-effect",
]);

/** Capture adapters and retain only the legacy model provider by identity. */
export function captureHostBrokerAdapters(
  value: HostBrokerAdaptersV1,
): CapturedHostBrokerAdaptersV1 {
  const opaque = opaqueBrokerValues(value);
  const brokers = captureHostDefinition(value, opaque) as HostBrokerAdaptersV1;
  if (Object.keys(brokers).some((key) => !BROKER_KEYS.has(key))) throw adapterError();
  return { brokers, opaque };
}

/** Refuse captured definition drift before host adapter I/O. */
export function assertHostBrokerAdaptersStable(
  source: HostBrokerAdaptersV1, expected: CapturedHostBrokerAdaptersV1,
): void {
  const current = captureHostBrokerAdapters(source);
  const opaque = new Set([...expected.opaque, ...current.opaque]);
  if (!sameHostDefinition(current.brokers, expected.brokers, opaque)) {
    throw new Error("provider broker adapter definition has drifted");
  }
}

function opaqueBrokerValues(value: HostBrokerAdaptersV1): ReadonlySet<object> {
  try {
    const adapters = captureOwnDataRecord(value);
    if (adapters.model === undefined) return new Set();
    const model = captureOwnDataRecord(adapters.model);
    return typeof model.provider === "object" && model.provider !== null
      ? new Set([model.provider]) : new Set();
  } catch { throw adapterError(); }
}

function adapterError(): Error {
  return new Error("provider broker adapter definition is invalid");
}

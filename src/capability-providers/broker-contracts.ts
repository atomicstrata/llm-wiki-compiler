/**
 * @file src/capability-providers/broker-contracts.ts
 * @description Single source of truth for the seven host-reviewed Provider V2
 * broker contracts: grant kind, read-only/mutating/conditional access, and the
 * closed per-broker manifest grammar (allowed target-constraint keys and the
 * aggregate-maximum keys a signed requirement may tighten). This leaf module
 * imports no broker or package code, so the host registry and the package
 * broker-requirement parser both consume it without a module cycle.
 */
import type { ProviderBrokerMaximumsV1, ProviderGrantKindV1 } from "./authority/types.js";

/** Whether a registered broker performs read-only, mutating, or either work. */
export type BrokerAccessV1 = "read-only" | "mutating" | "conditional";

/** Closed host-owned contract facts for one compiled-in broker. */
export interface BrokerContractGrammarV1 {
  readonly brokerId: string;
  readonly brokerContractVersion: string;
  readonly grantKind: ProviderGrantKindV1;
  readonly access: BrokerAccessV1;
  readonly targetConstraintKeys: readonly string[];
  readonly maximumKeys: readonly (keyof ProviderBrokerMaximumsV1)[];
}

/** The exact seven compiled-in broker grammars; there is no dynamic entry. */
export const BROKER_CONTRACT_GRAMMARS: readonly BrokerContractGrammarV1[] = Object.freeze([
  grammar("https", "network.https", "conditional", ["allowedOrigins", "allowedMethods"], ["httpsTransferBytes"]),
  grammar("model", "model.invoke", "read-only", ["allowedServices", "allowedModels"], ["modelTokens", "modelCostUsd"]),
  grammar("repository", "repository.snapshot", "read-only", ["allowedRemotes"], []),
  grammar("command", "command.execute", "conditional", ["allowedToolIds"], ["commandAcceptedBytes"]),
  grammar("scheduler", "scheduler.write", "mutating", ["allowedJobTargets"], []),
  grammar("email", "email.send", "mutating", ["allowedRecipients"], []),
  grammar("remote-effect", "external.mutate", "mutating", ["allowedTargets"], []),
]);

/** Resolve the exact compiled-in grammar for a broker id and contract version. */
export function findBrokerContractGrammar(
  brokerId: string, brokerContractVersion: string,
): BrokerContractGrammarV1 | undefined {
  return BROKER_CONTRACT_GRAMMARS.find((entry) => entry.brokerId === brokerId
    && entry.brokerContractVersion === brokerContractVersion);
}

function grammar(
  brokerId: string, grantKind: ProviderGrantKindV1, access: BrokerAccessV1,
  targetConstraintKeys: readonly string[],
  maximumKeys: readonly (keyof ProviderBrokerMaximumsV1)[],
): BrokerContractGrammarV1 {
  return Object.freeze({
    brokerId, brokerContractVersion: "1.0.0", grantKind, access,
    targetConstraintKeys: Object.freeze([...targetConstraintKeys]),
    maximumKeys: Object.freeze([...maximumKeys]),
  });
}

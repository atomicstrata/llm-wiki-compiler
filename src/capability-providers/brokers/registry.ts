/**
 * @file src/capability-providers/brokers/registry.ts
 * @description Opaque closed registry for the seven host-reviewed Provider V2
 * broker contracts. There is deliberately no dynamic registration path.
 */
import { BROKER_CONTRACT_GRAMMARS, type BrokerContractGrammarV1 } from "../broker-contracts.js";
import { parseBrokerId, parseSemanticVersion } from "../ids.js";
import type { HostBrokerContractV1 } from "./types.js";

declare const hostBrokerRegistryBrand: unique symbol;
/** Opaque registry handle; callers cannot enumerate or mutate its backing map. */
export interface HostBrokerRegistryV1 { readonly [hostBrokerRegistryBrand]: true }

const CONTRACTS: readonly HostBrokerContractV1[] = Object.freeze(
  BROKER_CONTRACT_GRAMMARS.map(contract),
);
const registryContracts = new WeakMap<object, readonly HostBrokerContractV1[]>();

/** Mint one registry containing exactly the compiled-in contracts. */
export function createHostBrokerRegistry(): HostBrokerRegistryV1 {
  const registry = Object.freeze({}) as HostBrokerRegistryV1;
  registryContracts.set(registry, CONTRACTS);
  return registry;
}

/** Return immutable display metadata without exposing a mutable registry map. */
export function listHostBrokerContracts(
  registry: HostBrokerRegistryV1,
): readonly HostBrokerContractV1[] {
  return requireContracts(registry);
}

/** Resolve only an exact compiled-in broker ID and contract version. */
export function resolveHostBrokerContract(
  registry: HostBrokerRegistryV1,
  brokerId: unknown,
  brokerContractVersion: unknown,
): HostBrokerContractV1 | undefined {
  const contracts = requireContracts(registry);
  try {
    const id = parseBrokerId(brokerId);
    const version = parseSemanticVersion(brokerContractVersion);
    return contracts.find((entry) => entry.brokerId === id
      && entry.brokerContractVersion === version);
  } catch { return undefined; }
}

function contract(grammar: BrokerContractGrammarV1): HostBrokerContractV1 {
  return Object.freeze({
    brokerId: parseBrokerId(grammar.brokerId),
    brokerContractVersion: parseSemanticVersion(grammar.brokerContractVersion),
    grantKind: grammar.grantKind,
    access: grammar.access,
  });
}

function requireContracts(registry: HostBrokerRegistryV1): readonly HostBrokerContractV1[] {
  const contracts = registryContracts.get(registry);
  if (!contracts) throw new Error("provider broker registry is invalid");
  return contracts;
}

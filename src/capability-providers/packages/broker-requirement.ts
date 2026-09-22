/**
 * @file src/capability-providers/packages/broker-requirement.ts
 * @description Exact, closed parsing of signed capability broker requirements.
 * Every requirement is validated against the compiled-in host broker contract
 * grammar: an unknown broker id or contract version, an access class the broker
 * does not offer, an unknown target-constraint or maximum key, or a maximum
 * that would widen its host ceiling all fail closed before the manifest loads.
 */
import { captureDenseArray, captureExactRecord, captureOwnDataRecord } from "../../utils/runtime-capture.js";
import { isWellFormedUnicode } from "../../utils/well-formed-unicode.js";
import {
  BROKER_CONTRACT_GRAMMARS, findBrokerContractGrammar, type BrokerContractGrammarV1,
} from "../broker-contracts.js";
import { BROKER_AGGREGATE_MAXIMUM_CEILINGS } from "../constants.js";
import { parseBrokerId, parseSemanticVersion } from "../ids.js";
import type { ProviderBrokerMaximumsV1 } from "../authority/types.js";
import type { BrokerRequirementV1 } from "./protocol.js";

const MAX_REQUIREMENTS = BROKER_CONTRACT_GRAMMARS.length;
const MAX_LIST_ITEMS = 128;
const MAX_CONSTRAINT_VALUES = 256;
const REQUIREMENT_KEYS = Object.freeze([
  "brokerId", "brokerContractVersion", "operations", "effectClass", "access",
  "requiredCredentialSlots", "exposedInputKinds", "targetConstraints", "maximums",
] as const);

/** Parse the closed broker-requirement list declared by one signed capability. */
export function parseBrokerRequirements(value: unknown): readonly BrokerRequirementV1[] {
  const requirements = captureDenseArray(value, MAX_REQUIREMENTS, parseRequirement, requirementError);
  rejectDuplicateBrokers(requirements);
  return Object.freeze(requirements);
}

function parseRequirement(value: unknown): BrokerRequirementV1 {
  const record = captureExactRecord(value, REQUIREMENT_KEYS);
  const brokerId = parseBrokerId(record.brokerId);
  const brokerContractVersion = parseSemanticVersion(record.brokerContractVersion);
  const grammar = findBrokerContractGrammar(brokerId, brokerContractVersion);
  if (!grammar) throw requirementError();
  const access = requirementAccess(record.access, grammar);
  return Object.freeze({
    brokerId, brokerContractVersion, effectClass: token(record.effectClass), access,
    operations: tokenList(record.operations, 1),
    requiredCredentialSlots: tokenList(record.requiredCredentialSlots, 0),
    exposedInputKinds: tokenList(record.exposedInputKinds, 0),
    targetConstraints: parseTargetConstraints(record.targetConstraints, grammar),
    maximums: parseRequirementMaximums(record.maximums, grammar),
  });
}

function requirementAccess(
  value: unknown, grammar: BrokerContractGrammarV1,
): "read-only" | "mutating" {
  if (value !== "read-only" && value !== "mutating") throw requirementError();
  if (grammar.access !== "conditional" && grammar.access !== value) throw requirementError();
  return value;
}

function parseTargetConstraints(
  value: unknown, grammar: BrokerContractGrammarV1,
): Readonly<Record<string, readonly string[]>> {
  const record = captureOwnDataRecord(value);
  const allowed = new Set<string>(grammar.targetConstraintKeys);
  const result = Object.create(null) as Record<string, readonly string[]>;
  for (const [key, values] of Object.entries(record)) {
    if (!allowed.has(key)) throw requirementError();
    result[key] = tokenList(values, 1);
  }
  return Object.freeze(result);
}

function parseRequirementMaximums(
  value: unknown, grammar: BrokerContractGrammarV1,
): Readonly<Partial<ProviderBrokerMaximumsV1>> {
  const record = captureOwnDataRecord(value);
  const allowed = new Set<string>(grammar.maximumKeys);
  const result: Record<string, number> = {};
  for (const [key, candidate] of Object.entries(record)) {
    if (!allowed.has(key)) throw requirementError();
    if (!validRequirementMaximum(key as keyof ProviderBrokerMaximumsV1, candidate)) throw requirementError();
    result[key] = Number(candidate);
  }
  return Object.freeze(result) as Readonly<Partial<ProviderBrokerMaximumsV1>>;
}

function validRequirementMaximum(
  key: keyof ProviderBrokerMaximumsV1, value: unknown,
): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    && (key === "modelCostUsd" || Number.isSafeInteger(value))
    && value <= BROKER_AGGREGATE_MAXIMUM_CEILINGS[key];
}

function tokenList(value: unknown, minimum: number): readonly string[] {
  const values = captureDenseArray(value, MAX_LIST_ITEMS, token, requirementError);
  if (values.length < minimum || values.length > MAX_CONSTRAINT_VALUES
    || new Set(values).size !== values.length) throw requirementError();
  return Object.freeze(values);
}

function token(value: unknown): string {
  if (typeof value !== "string" || !isWellFormedUnicode(value)
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) throw requirementError();
  return value;
}

function rejectDuplicateBrokers(requirements: readonly BrokerRequirementV1[]): void {
  const ids = requirements.map((item) => item.brokerId);
  if (new Set(ids).size !== ids.length) throw requirementError();
}

function requirementError(): Error {
  return new Error("provider broker requirement is invalid");
}

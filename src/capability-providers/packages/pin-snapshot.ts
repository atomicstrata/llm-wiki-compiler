/**
 * @file src/capability-providers/packages/pin-snapshot.ts
 * @description Closed runtime normalization for caller-supplied Provider V2
 * pins. Descriptor reads avoid getters, and the returned frozen DTO never
 * retains the caller object across asynchronous resolution.
 */
import { types } from "node:util";
import type { ProviderPinV1 } from "../types.js";

const PROVIDER_PIN_FIELDS = [
  "schemaVersion", "coordinate", "providerId", "providerVersion", "packageDigest",
  "manifestDigest", "capabilityId", "capabilityContractVersion", "capabilitySchemaDigest",
] as const satisfies readonly (keyof ProviderPinV1)[];

const PROVIDER_PIN_STRING_FIELDS = [
  "coordinate", "providerId", "providerVersion", "packageDigest", "manifestDigest",
  "capabilityId", "capabilityContractVersion", "capabilitySchemaDigest",
] as const satisfies readonly Exclude<keyof ProviderPinV1, "schemaVersion">[];

/** Snapshot only the exact plain data-object pin shape before any asynchronous work. */
export function snapshotProviderPin(pin: ProviderPinV1): ProviderPinV1 {
  try {
    if (!isPlainPinObject(pin)) throw integrityError();
    const values = pinValues(pin);
    if (!hasExpectedPrimitiveValues(values)) throw integrityError();
    return Object.freeze({
      schemaVersion: values.schemaVersion as 1,
      coordinate: values.coordinate as ProviderPinV1["coordinate"],
      providerId: values.providerId as ProviderPinV1["providerId"],
      providerVersion: values.providerVersion as ProviderPinV1["providerVersion"],
      packageDigest: values.packageDigest as ProviderPinV1["packageDigest"],
      manifestDigest: values.manifestDigest as ProviderPinV1["manifestDigest"],
      capabilityId: values.capabilityId as ProviderPinV1["capabilityId"],
      capabilityContractVersion: values.capabilityContractVersion as ProviderPinV1["capabilityContractVersion"],
      capabilitySchemaDigest: values.capabilitySchemaDigest as ProviderPinV1["capabilitySchemaDigest"],
    });
  } catch { throw integrityError(); }
}

/** Reject proxies, inherited fields, symbols, accessors, and unknown keys without invoking values. */
function isPlainPinObject(pin: unknown): pin is Record<keyof ProviderPinV1, unknown> {
  if (typeof pin !== "object" || pin === null || Array.isArray(pin) || types.isProxy(pin)) return false;
  if (Object.getPrototypeOf(pin) !== Object.prototype) return false;
  const own = Reflect.ownKeys(pin);
  return own.length === PROVIDER_PIN_FIELDS.length
    && PROVIDER_PIN_FIELDS.every((field) => own.includes(field));
}

/** Copy only own enumerable data descriptor values into a fresh closed record. */
function pinValues(pin: Record<keyof ProviderPinV1, unknown>): Record<keyof ProviderPinV1, unknown> {
  const values = {} as Record<keyof ProviderPinV1, unknown>;
  for (const field of PROVIDER_PIN_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(pin, field);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw integrityError();
    values[field] = descriptor.value;
  }
  return values;
}

/** Check the closed pin schema before any caller value reaches a normalized snapshot. */
function hasExpectedPrimitiveValues(values: Record<keyof ProviderPinV1, unknown>): boolean {
  return values.schemaVersion === 1
    && PROVIDER_PIN_STRING_FIELDS.every((field) => typeof values[field] === "string");
}

/** Return the stable redacted integrity error used when no trustworthy pin exists. */
function integrityError(): Error {
  return new Error("provider integrity verification failed");
}

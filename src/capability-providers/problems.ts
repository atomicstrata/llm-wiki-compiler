/**
 * @file src/capability-providers/problems.ts
 * @description Closed stable Provider V2 public problem taxonomy and strict
 * parser. Payload-derived or future strings cannot silently become a known
 * status, including the catch-all provider-failed code.
 */
export const PROVIDER_PROBLEM_CODES = Object.freeze([
  "provider-not-installed",
  "provider-package-missing",
  "provider-package-integrity-invalid",
  "provider-signature-invalid",
  "provider-revoked",
  "provider-revocation-evidence-stale",
  "provider-local-unverified",
  "provider-host-incompatible",
  "provider-protocol-incompatible",
  "provider-platform-incompatible",
  "provider-isolation-unavailable",
  "provider-broker-unavailable",
  "provider-grant-missing",
  "provider-credential-missing",
  "provider-credential-unreadable",
  "provider-bounds-invalid",
  "provider-protocol-invalid",
  "provider-output-invalid",
  "provider-timed-out",
  "provider-resource-exhausted",
  "provider-cancelled",
  "provider-terminated",
  "provider-failed",
  "provider-partial",
  "provider-drift",
  "provider-effect-not-approved",
  "provider-effect-outcome-unknown",
  "provider-store-unavailable",
] as const);

export type ProviderProblemCodeV1 = (typeof PROVIDER_PROBLEM_CODES)[number];

const PROBLEM_CODE_SET: ReadonlySet<string> = new Set(PROVIDER_PROBLEM_CODES);
const MAX_PROBLEM_CODE_UNITS = Math.max(...PROVIDER_PROBLEM_CODES.map((code) => code.length));

/** Parse only a published Provider V2 problem code; unknown values fail closed. */
export function parseProviderProblemCode(value: unknown): ProviderProblemCodeV1 {
  if (typeof value !== "string") {
    const received = value === null ? "null" : typeof value;
    throw new Error(`unknown provider problem code: expected string; received ${received}`);
  }
  if (value.length > MAX_PROBLEM_CODE_UNITS) throw unknownProblemCode();
  if (!PROBLEM_CODE_SET.has(value)) throw unknownProblemCode();
  return value as ProviderProblemCodeV1;
}

function unknownProblemCode(): Error {
  return new Error("unknown provider problem code: unrecognized string");
}

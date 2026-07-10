/**
 * @file src/connectors/hash.ts
 * @description Connector hashing helpers shared by review display and approval gates.
 */
import { createHash } from "node:crypto";

/**
 * Compute the SHA-256 digest of an exact text body.
 *
 * Connector approval pins the human-reviewed composed candidate body, not the
 * transient upstream fetch bytes and not a stored self-attested provenance field.
 */
export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

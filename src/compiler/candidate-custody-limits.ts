/**
 * @file src/compiler/candidate-custody-limits.ts
 * @description Host-selected limits for candidate custody reads, split out so
 * runtime boundary capture does not form an import cycle. Ordinary public local
 * operations preserve their previous size behavior; new authority ports bound it.
 */

/** Maximum raw bytes accepted by the new bounded custody interfaces. */
export const MAX_CANDIDATE_RECORD_BYTES = 4 * 1024 * 1024;

/** Host-selected policy; legacy local operations have no new product byte cap. */
export type CandidateCustodyPolicy = "bounded" | "public";

/** New authority ports retain their cap unless the host selects public parity. */
export function candidateByteLimit(policy: CandidateCustodyPolicy): number {
  return policy === "public" ? Number.MAX_SAFE_INTEGER : MAX_CANDIDATE_RECORD_BYTES;
}

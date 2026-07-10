/**
 * @file src/trust/apply-result.ts
 * @description The executor's kind-discriminated apply RESULT and the typed
 * batch-shape guard error. A `relation` apply yields the persisted RelationRef
 * back through the seam (so a public caller never bypasses the executor to read
 * it); `relation` and `lifecycle-transition` ALSO carry the {@link TrustDecision}
 * the under-lock authority composed (e.g. `allow` vs `allow-with-warning`), so a
 * consumer records the REAL decision rather than a hardcoded literal; `page`
 * yields no value (its decision is already known plan-side).
 * CrossStoreBatchUnsupportedError is thrown when a batch shape cannot be applied
 * atomically under today's single-store durability (cross-store op-ID atomicity
 * is a Phase-5 task).
 */
import type { RelationRef } from "../relations/types.js";
import type { ArtifactRef } from "../artifacts/ref.js";
import type { TrustDecision } from "./decision.js";

export type ApplyResult =
  | { kind: "page" }
  | { kind: "relation"; ref: RelationRef; decision: TrustDecision }
  | { kind: "lifecycle-transition"; decision: TrustDecision }
  | { kind: "artifact"; ref: ArtifactRef; decision: TrustDecision };

export class CrossStoreBatchUnsupportedError extends Error {
  constructor(reason: string) {
    super(`cross-store-batch-unsupported: ${reason}`);
    this.name = "CrossStoreBatchUnsupportedError";
  }
}

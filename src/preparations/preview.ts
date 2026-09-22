/**
 * @file src/preparations/preview.ts
 * @description The strict, provider-free preparation preview (design sections
 * 28.2 / 31.8). A preview compiles the manifest, runs every read-only preflight,
 * and computes the projected run budget, but resolves no key, creates no
 * directory, and publishes no evidence, manifest, or run. It reuses the durable
 * staging transaction on its forced dry-run path so a supplied `dryRun` flag can
 * never downgrade preview purity and the two paths cannot diverge; a fresh
 * project with no key epoch parks rather than minting a key.
 */

import {
  stagePreparationLocked, type StagePreparationRequest, type StagePreparationResult,
} from "./stage.js";

/**
 * Purely preview one preparation without writing any project byte. It invokes
 * nothing and leaves a byte-identical project/runtime snapshot on every outcome,
 * including an invalid-plan preview and a backend-unavailable project.
 *
 * CALLED WITHOUT THE PROJECT LOCK, deliberately, and that is a departure from
 * {@link stagePreparationLocked}'s stated precondition rather than an oversight.
 * The forced dry run returns before `publishStage` on every branch, and a key
 * epoch minted for an empty project carries its durable write in a deferred
 * `publish` this path never calls — so there is no write to serialize against.
 *
 * THE LOCK WAS NOT FREE TO HOLD. `acquireMutationLock` runs the recovery gate,
 * which settles outstanding preparation handoffs; taking it made this operation
 * advance an unrelated run's durable state, which is the one thing its name
 * promises it will not do. What holding it bought was a consistent snapshot, so
 * the cost of dropping it is a stale answer or a raw read fault under a
 * concurrent stage — never a byte.
 */
export async function previewPreparation(
  root: string, request: StagePreparationRequest,
): Promise<StagePreparationResult> {
  return stagePreparationLocked(root, { ...request, dryRun: true });
}

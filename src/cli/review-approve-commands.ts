/**
 * @file src/cli/review-approve-commands.ts
 * @description Configures `review approve` and `review approve-batch`, which
 * promote candidates into the wiki.
 */

import type { Command } from "commander";
import reviewApproveCommand from "@atomicstrata/llmwiki-core/modules/commands/review-approve";
import reviewApproveBatchCommand from "@atomicstrata/llmwiki-core/modules/commands/review-approve-batch";
import { withReviewErrors } from "./review-errors.js";

/** Add the options and action of `review approve`. */
export function configureReviewApprove(command: Command): void {
  command
    .option("--draft-content-hash <hex>", "Required for connector candidates: sha256 printed by review show")
    .action(withReviewErrors(reviewApproveCommand));
}

/** Add the options and action of `review approve-batch`; it owns its JSON error envelope. */
export function configureReviewApproveBatch(command: Command): void {
  command
    .requiredOption("--input <file>", "Versioned JSON approval manifest")
    .option("--json", "Print a single machine-readable result")
    .action(reviewApproveBatchCommand);
}

/**
 * @file src/cli/review-commands.ts
 * @description Registers the `review` command group: inspect and act on
 * pending compile review candidates (`review list`, `review show`,
 * `review approve`, `review approve-batch`, `review reject`). Legacy actions
 * share human error handling; the batch action owns its JSON error envelope.
 */

import type { Command } from "commander";
import { reviewListCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { reviewShowCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { reviewApproveCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { reviewRejectCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { reviewApproveBatchCommand } from "@atomicstrata/llmwiki-core/compiler-cli";

/** Register the review inspection, approval, batch approval, and rejection commands. */
export function registerReviewCommands(program: Command): void {
  const reviewCommand = program
    .command("review")
    .description("Inspect and act on pending compile review candidates");

  reviewCommand
    .command("list")
    .description("List pending review candidates")
    .action(withReviewErrors(reviewListCommand));

  reviewCommand
    .command("show <id>")
    .description("Print a single candidate's metadata and body")
    .action(withReviewErrors(reviewShowCommand));

  reviewCommand
    .command("approve <id>")
    .description("Approve a candidate and promote it into wiki/concepts/")
    .option("--draft-content-hash <hex>", "Required for connector candidates: sha256 printed by review show")
    .action(withReviewErrors(reviewApproveCommand));

  reviewCommand
    .command("approve-batch")
    .description("Approve a manifest of candidates with one shared finalization")
    .requiredOption("--input <file>", "Versioned JSON approval manifest")
    .option("--json", "Print a single machine-readable result")
    .action(reviewApproveBatchCommand);

  reviewCommand
    .command("reject <id>")
    .description("Reject a candidate and archive it without touching wiki/")
    .action(withReviewErrors(reviewRejectCommand));
}

/** Preserve the legacy human error handling for each non-batch review action. */
function withReviewErrors<Args extends unknown[]>(action: (...args: Args) => Promise<void>) {
  return async (...args: Args): Promise<void> => {
    try {
      await action(...args);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  };
}

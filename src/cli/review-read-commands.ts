/**
 * @file src/cli/review-read-commands.ts
 * @description Configures the read-only `review list` and `review show`
 * subcommands.
 */

import type { Command } from "commander";
import reviewListCommand from "@atomicstrata/llmwiki-core/modules/commands/review-list";
import reviewShowCommand from "@atomicstrata/llmwiki-core/modules/commands/review-show";
import { withReviewErrors } from "./review-errors.js";

/** Add the action of `review list`. */
export function configureReviewList(command: Command): void {
  command.action(withReviewErrors(reviewListCommand));
}

/** Add the action of `review show`. */
export function configureReviewShow(command: Command): void {
  command.action(withReviewErrors(reviewShowCommand));
}

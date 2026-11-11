/**
 * @file src/cli/review-reject-command.ts
 * @description Configures `review reject`, which archives a candidate without
 * touching `wiki/`.
 */

import type { Command } from "commander";
import reviewRejectCommand from "@atomicstrata/llmwiki-core/modules/commands/review-reject";
import { withReviewErrors } from "./review-errors.js";

/** Add the action of `review reject`. */
export function configureReviewReject(command: Command): void {
  command.action(withReviewErrors(reviewRejectCommand));
}

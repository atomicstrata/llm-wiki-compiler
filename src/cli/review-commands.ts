/**
 * @file src/cli/review-commands.ts
 * @description Registers the `review` command group: inspect and act on
 * pending compile review candidates (`review list`, `review show`,
 * `review approve`, `review approve-batch`, `review reject`). Legacy actions
 * share human error handling; the batch action owns its JSON error envelope.
 *
 * Each subcommand's module loads when it runs, so `review list` and
 * `review show` do not load the approval and rejection paths.
 */

import type { Command } from "commander";
import { declareLazyCommands, type LazyCommand } from "./lazy-commands.js";

/** The review subcommands in help order, with the module that configures each. */
const REVIEW_COMMANDS: LazyCommand[] = [
  ["list", "List pending review candidates",
    () => import("./review-read-commands.js").then((m) => m.configureReviewList)],
  ["show <id>", "Print a single candidate's metadata and body",
    () => import("./review-read-commands.js").then((m) => m.configureReviewShow)],
  ["approve [options] <id>", "Approve a candidate and promote it into wiki/concepts/",
    () => import("./review-approve-commands.js").then((m) => m.configureReviewApprove)],
  ["approve-batch [options]", "Approve a manifest of candidates with one shared finalization",
    () => import("./review-approve-commands.js").then((m) => m.configureReviewApproveBatch)],
  ["reject <id>", "Reject a candidate and archive it without touching wiki/",
    () => import("./review-reject-command.js").then((m) => m.configureReviewReject)],
];

/** Register the review inspection, approval, batch approval, and rejection commands. */
export function registerReviewCommands(reviewCommand: Command): void {
  declareLazyCommands(reviewCommand, REVIEW_COMMANDS);
}

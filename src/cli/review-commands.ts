/**
 * @file src/cli/review-commands.ts
 * @description Registers the `review` command group: inspect and act on
 * pending compile review candidates (`review list`, `review show`,
 * `review approve`, `review reject`). Moved out of `src/cli.ts` verbatim
 * (pure move, no behavior change) as part of the per-domain command split.
 */

import type { Command } from "commander";
import reviewListCommand from "../commands/review-list.js";
import reviewShowCommand from "../commands/review-show.js";
import reviewApproveCommand from "../commands/review-approve.js";
import reviewRejectCommand from "../commands/review-reject.js";

/** Register the `review` command group (`list`, `show`, `approve`, `reject`) on `program`. */
export function registerReviewCommands(program: Command): void {
  const reviewCommand = program
    .command("review")
    .description("Inspect and act on pending compile review candidates");

  reviewCommand
    .command("list")
    .description("List pending review candidates")
    .action(async () => {
      try {
        await reviewListCommand();
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  reviewCommand
    .command("show <id>")
    .description("Print a single candidate's metadata and body")
    .action(async (id: string) => {
      try {
        await reviewShowCommand(id);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  reviewCommand
    .command("approve <id>")
    .description("Approve a candidate and promote it into wiki/concepts/")
    .option("--draft-content-hash <hex>", "Required for connector candidates: sha256 printed by review show")
    .action(async (id: string, options: { draftContentHash?: string }) => {
      try {
        await reviewApproveCommand(id, options);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  reviewCommand
    .command("reject <id>")
    .description("Reject a candidate and archive it without touching wiki/")
    .action(async (id: string) => {
      try {
        await reviewRejectCommand(id);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

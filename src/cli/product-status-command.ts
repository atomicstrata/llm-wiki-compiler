/**
 * @file src/cli/product-status-command.ts
 * @description Configures `product status`, the read-only readiness review of
 * the active product's optional capabilities.
 */

import type { Command } from "commander";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/modules/cli/shared";
import { productStatusCommand, type ProductStatusOptions } from "@atomicstrata/llmwiki-core/modules/commands/product/status";
import { JSON_DESCRIPTION } from "./product-json-option.js";

/** Add the options and action of `product status`. */
export function configureProductStatus(command: Command): void {
  command
    .option("--json", JSON_DESCRIPTION)
    // A recorded skip stays LISTED in the review: the decision is the thing
    // being stored, so a reader can tell it apart from an oversight.
    .option("--skip <dimension>", "Record that you are declining this optional capability")
    .option("--unskip <dimension>", "Clear a previously recorded skip")
    .action(async (options: ProductStatusOptions) =>
      runExitCodeCommand(() => productStatusCommand(process.cwd(), options)));
}

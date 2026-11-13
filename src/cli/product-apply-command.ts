/**
 * @file src/cli/product-apply-command.ts
 * @description Configures `product apply`, the one verb in the group that
 * writes: it approves and applies a bundle `invoke` proposed.
 */

import type { Command } from "commander";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/modules/cli/shared";
import { productApplyCommand, type ProductApplyOptions } from "@atomicstrata/llmwiki-core/modules/commands/product/apply";
import { JSON_DESCRIPTION } from "./product-json-option.js";

/** Add the options and action of `product apply`. */
export function configureProductApply(command: Command): void {
  command
    .option("--json", JSON_DESCRIPTION)
    .action(async (bundle: string, options: ProductApplyOptions) =>
      runExitCodeCommand(() => productApplyCommand(process.cwd(), bundle, options)));
}

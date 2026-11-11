/**
 * @file src/cli/product-action-commands.ts
 * @description Configures the `product` verbs that run the active product's
 * actions: `preview`, `invoke` and `resume`.
 */

import type { Command } from "commander";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/modules/cli/shared";
import { productInvokeCommand, productResumeCommand, productPreviewCommand } from "@atomicstrata/llmwiki-core/modules/commands/product/action";
import type { ProductActionOptions } from "@atomicstrata/llmwiki-core/modules/commands/product/inputs";
import { JSON_DESCRIPTION } from "./product-json-option.js";

/**
 * The flags both action verbs take, declared ONCE.
 *
 * Registering them twice is how `--input` comes to mean one thing on `preview`
 * and another on `invoke` — and the entire value of preview is that it cannot
 * diverge from the invocation it previews, which has to include how its input is
 * spelled.
 */
function withActionOptions(command: Command): Command {
  return command
    .option("--input <pair...>", "Action input as key=value (repeatable; every value is a STRING)")
    .option("--input-json <json>",
      "Action input as a JSON object of typed values (numbers, booleans, lists); wins over --input on a key collision")
    .option("--workspace <id>", "Workspace the run is recorded under (default \"default\")")
    .option("--json", JSON_DESCRIPTION);
}

/** Add the options and action of `product preview`. */
export function configureProductPreview(command: Command): void {
  withActionOptions(command)
    .action(async (token: string, options: ProductActionOptions) =>
      runExitCodeCommand(() => productPreviewCommand(process.cwd(), token, options)));
}

/** Add the options and action of `product invoke`. */
export function configureProductInvoke(command: Command): void {
  withActionOptions(command)
    .action(async (token: string, options: ProductActionOptions) =>
      runExitCodeCommand(() => productInvokeCommand(process.cwd(), token, options)));
}

/** Add the options and action of `product resume`. */
export function configureProductResume(command: Command): void {
  withActionOptions(command)
    .action(async (runId: string, token: string, options: ProductActionOptions) =>
      runExitCodeCommand(() => productResumeCommand(process.cwd(), runId, token, options)));
}

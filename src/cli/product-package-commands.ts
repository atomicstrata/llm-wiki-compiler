/**
 * @file src/cli/product-package-commands.ts
 * @description Configures the `product` verbs that put a package in the
 * project and make it authoritative: `install`, `activate` and `init`.
 */

import type { Command } from "commander";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/modules/cli/shared";
import { productActivateCommand, productInstallCommand, type ProductPackageOptions } from "@atomicstrata/llmwiki-core/modules/commands/product/package";
import { productInitCommand } from "@atomicstrata/llmwiki-core/modules/commands/product/init";
import { JSON_DESCRIPTION } from "./product-json-option.js";

/** Add the options and action of `product install`. */
export function configureProductInstall(command: Command): void {
  command
    .option("--json", JSON_DESCRIPTION)
    .action(async (sourceDir: string, options: ProductPackageOptions) =>
      runExitCodeCommand(() => productInstallCommand(process.cwd(), sourceDir, options)));
}

/** Add the options and action of `product activate`. */
export function configureProductActivate(command: Command): void {
  command
    .option("--json", JSON_DESCRIPTION)
    .action(async (packageDigest: string, options: ProductPackageOptions) =>
      runExitCodeCommand(() => productActivateCommand(process.cwd(), packageDigest, options)));
}

/** Add the options and action of `product init`. */
export function configureProductInit(command: Command): void {
  command
    .option("--json", JSON_DESCRIPTION)
    .action(async (sourceDir: string, options: ProductPackageOptions) =>
      runExitCodeCommand(() => productInitCommand(process.cwd(), sourceDir, options)));
}

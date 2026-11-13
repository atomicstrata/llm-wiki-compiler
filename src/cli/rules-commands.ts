/**
 * @file Registers the `rules` command group with the CLI provider guard.
 */

import type { Command } from "commander";
import { registerRulesCommand } from "@atomicstrata/llmwiki-core/modules/commands/rules-register";
import { requireProvider } from "./require-provider.js";

/** Register the `rules` command group. */
export function registerRulesCommands(command: Command): void {
  registerRulesCommand(command, requireProvider);
}

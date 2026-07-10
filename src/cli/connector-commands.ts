/**
 * @file src/cli/connector-commands.ts
 * @description Registers the `connector` command group for first-party external-data connectors.
 */

import type { Command } from "commander";
import { connectorListCommand, connectorRunCommand } from "../commands/connector.js";
import type { ConnectorRunOptions } from "../commands/connector.js";

/** Register connector discovery and run commands on the root Commander program. */
export function registerConnectorCommands(program: Command): void {
  const connector = program
    .command("connector")
    .description("List and run first-party external-data connectors into review candidates");

  connector
    .command("list")
    .description("List registered connectors and their activation/profile binding state")
    .action(async () => {
      try {
        await connectorListCommand();
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  connector
    .command("run <id>")
    .description("Fetch external data and stage a typed review candidate")
    .option("--input <pair...>", "Connector input as key=value")
    .action(async (id: string, options: ConnectorRunOptions) => {
      try {
        await connectorRunCommand(id, options);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

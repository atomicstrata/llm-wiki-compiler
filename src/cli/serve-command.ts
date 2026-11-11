/**
 * @file Registers `serve`: start the MCP server over stdio.
 */

import type { Command } from "commander";
import { startMCPServer } from "../mcp/server.js";

/** Add the options and action of the `serve` command. */
export function registerServeCommand(command: Command, version: string): void {
  command
    .option("--root <dir>", "Project root directory", process.cwd())
    .action(async (options: { root: string }) => {
      try {
        // Per-tool credential checks happen inside the MCP layer so read-only
        // tools and ingest still work without an API key.
        await startMCPServer({ root: options.root, version });
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

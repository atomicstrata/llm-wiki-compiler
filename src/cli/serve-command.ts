/**
 * @file Registers `serve`: start the MCP server over stdio.
 *
 * With `--project <ref>` (a registered directory, or a host URL ending in a
 * project id, with `--token` for a hosted project) the server is bound to one
 * portable project instead of `--root`; the session is opened only when the
 * server asks for it.
 */

import type { Command } from "commander";
import { openCommandSession } from "@atomicstrata/llmwiki-core/compiler-cli";
import { startMCPServer } from "../mcp/server.js";

interface ServeOptions {
  root: string;
  project?: string;
  token?: string;
}

/** Add the options and action of the `serve` command. */
export function registerServeCommand(command: Command, version: string): void {
  command
    .option("--root <dir>", "Project root directory", process.cwd())
    .option("--project <ref>", "Serve a portable project instead (registered directory, or host URL ending in a project id)")
    .option("--token <token>", "Host or service token for a hosted portable project")
    .action(async (options: ServeOptions) => {
      try {
        // Per-tool credential checks happen inside the MCP layer so read-only
        // tools and ingest still work without an API key.
        const portable = options.project
          ? () => openCommandSession({ project: options.project, token: options.token })
          : undefined;
        await startMCPServer({ root: options.root, version, portable });
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

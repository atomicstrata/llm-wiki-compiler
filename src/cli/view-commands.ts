/**
 * @file src/cli/view-commands.ts
 * @description Registers the viewer commands: `view` serves the original
 * browser client and `view-v2` serves the framework-based client. Both start
 * the same local read-only server and JSON API and accept the same bind
 * options, so they share one registration and one error path.
 */

import type { Command } from "commander";
import { viewCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { resolvePort } from "./view-port.js";

/** Bind options shared by every viewer command. */
interface ViewCliOptions {
  port?: string;
  host?: string;
  allowLan?: boolean;
  open?: boolean;
}

/** One viewer command: its name, help text, and the client it serves. */
interface ViewCommandSpec {
  name: string;
  description: string;
  ui?: "v2";
}

const VIEW_COMMANDS: readonly ViewCommandSpec[] = [
  { name: "view", description: "Start a local read-only web viewer for the current wiki project" },
  {
    name: "view-v2",
    description: "Start the local read-only web viewer with the v2 client (pages, sources, images)",
    ui: "v2",
  },
];

/** Register `view` and `view-v2`. */
export function registerViewCommands(program: Command): void {
  for (const spec of VIEW_COMMANDS) registerViewCommand(program, spec);
}

/** Register one viewer command with the shared bind options. */
function registerViewCommand(program: Command, spec: ViewCommandSpec): void {
  program
    .command(spec.name)
    .description(spec.description)
    .option("--port <port>", "Port to bind (default 0 — OS-assigned)")
    .option("--host <host>", "Host to bind (requires --allow-lan; default 127.0.0.1)")
    .option("--allow-lan", "Bind beyond loopback (requires --host); off by default for privacy")
    .option("--open", "Open the viewer in the default browser after startup")
    .action(async (options: ViewCliOptions) => {
      try {
        const port = resolvePort(options.port);
        await viewCommand({ ...options, port, ui: spec.ui });
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

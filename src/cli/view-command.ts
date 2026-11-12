/**
 * @file Registers `view`: start the local read-only web viewer.
 */

import type { Command } from "commander";
import viewCommand from "@atomicstrata/llmwiki-core/modules/commands/view";
import { resolvePort } from "./view-port.js";

/** Add the options and action of the `view` command. */
export function registerViewCommand(command: Command): void {
  command
    .option("--port <port>", "Port to bind (default 0 — OS-assigned)")
    .option("--host <host>", "Host to bind (requires --allow-lan; default 127.0.0.1)")
    .option("--allow-lan", "Bind beyond loopback (requires --host); off by default for privacy")
    .option("--open", "Open the viewer in the default browser after startup")
    .action(async (options: { port?: string; host?: string; allowLan?: boolean; open?: boolean }) => {
      try {
        const port = resolvePort(options.port);
        await viewCommand({ ...options, port });
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

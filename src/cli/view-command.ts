/**
 * @file Registers `view` and `view-v2`: start the local read-only web viewer.
 *
 * Both commands start the same server and JSON API and take the same options.
 * `view` serves the original browser client and `view-v2` the React client.
 */

import type { Command } from "commander";
import viewCommand from "@atomicstrata/llmwiki-core/modules/commands/view";
import { resolvePort } from "./view-port.js";

/** Options shared by both viewer commands. */
interface ViewCliOptions {
  port?: string;
  host?: string;
  allowLan?: boolean;
  open?: boolean;
  publicOrigin?: string;
}

/** Add the shared options, and an action that serves the given client. */
function configureViewCommand(command: Command, ui?: "v2"): void {
  command
    .option("--port <port>", "Port to bind (default 0 — OS-assigned)")
    .option("--host <host>", "Host to bind (requires --allow-lan; default 127.0.0.1)")
    .option("--allow-lan", "Bind beyond loopback (requires --host); off by default for privacy")
    .option("--open", "Open the viewer in the default browser after startup")
    .option(
      "--public-origin <origin>",
      "Origin a trusted reverse proxy serves the viewer at, e.g. https://wiki.example.com",
    )
    .action(async (options: ViewCliOptions) => {
      try {
        const port = resolvePort(options.port);
        await viewCommand({ ...options, port, ui });
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

/** Add the options and action of the `view` command. */
export function registerViewCommand(command: Command): void {
  configureViewCommand(command);
}

/** Add the options and action of the `view-v2` command. */
export function registerViewV2Command(command: Command): void {
  configureViewCommand(command, "v2");
}

/**
 * @file Registers `serve`: start the MCP server over stdio, or over streamable
 * HTTP on loopback with `--http`.
 */

import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { startMCPServer } from "../mcp/server.js";
import { parsePort } from "./view-port.js";

interface ServeOptions {
  root: string;
  http?: string;
  tokenFile?: string;
  readOnly?: boolean;
}

/** Read the bearer token from `tokenFile`; an empty file is refused. */
async function readToken(tokenFile: string): Promise<string> {
  const token = (await readFile(tokenFile, "utf-8")).trim();
  if (token.length === 0) throw new Error(`Token file is empty: ${tokenFile}`);
  return token;
}

/** Read the HTTP transport's port and, when `--token-file` is given, its bearer token. */
async function readHttpOptions(options: ServeOptions): Promise<{ port: number; token?: string } | undefined> {
  if (options.http === undefined) return undefined;
  const port = parsePort(options.http, "--http");
  return options.tokenFile === undefined ? { port } : { port, token: await readToken(options.tokenFile) };
}

/** Add the options and action of the `serve` command. */
export function registerServeCommand(command: Command, version: string): void {
  command
    .option("--root <dir>", "Project root directory", process.cwd())
    .option("--http <port>", "Serve streamable HTTP at 127.0.0.1:<port>/mcp instead of stdio")
    .option("--token-file <path>", "File holding the bearer token every HTTP request must present; without it only a loopback Host is admitted")
    .option("--read-only", "Expose only the tools that never write a project file")
    .action(async (options: ServeOptions) => {
      try {
        // Per-tool credential checks happen inside the MCP layer so read-only
        // tools and ingest still work without an API key.
        await startMCPServer({
          root: options.root,
          version,
          readOnly: options.readOnly,
          http: await readHttpOptions(options),
        });
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

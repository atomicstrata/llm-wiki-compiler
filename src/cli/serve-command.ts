/**
 * @file Registers `serve`: start the MCP server over stdio, or over streamable
 * HTTP on loopback with `--http`.
 *
 * With `--project <ref>` (a registered directory, or a host URL ending in a
 * project id, with `--token` for a hosted project) the server is bound to one
 * portable project instead of `--root`, over stdio; the session is opened only
 * when the server asks for it.
 */

import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { openCommandSession, type OpenSession } from "@atomicstrata/llmwiki-core/compiler-cli";
import { startMCPServer } from "../mcp/server.js";
import { parsePort } from "./view-port.js";

interface ServeOptions {
  root: string;
  project?: string;
  token?: string;
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

/** The portable project session `--project` asks for; it serves over stdio only. */
function portableSession(options: ServeOptions): OpenSession | undefined {
  const { project, token } = options;
  if (project === undefined) return undefined;
  if (options.http !== undefined || options.readOnly) {
    throw new Error("--http and --read-only serve a --root project; --project serves over stdio only");
  }
  return () => openCommandSession({ project, token });
}

/** Add the options and action of the `serve` command. */
export function registerServeCommand(command: Command, version: string): void {
  command
    .option("--root <dir>", "Project root directory", process.cwd())
    .option("--project <ref>", "Serve a portable project instead (registered directory, or host URL ending in a project id)")
    .option("--token <token>", "Host or service token for a hosted portable project")
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
          portable: portableSession(options),
          readOnly: options.readOnly,
          http: await readHttpOptions(options),
        });
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

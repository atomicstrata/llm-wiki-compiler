/**
 * MCP (Model Context Protocol) server entry point for llmwiki.
 *
 * Exposes llmwiki's automated pipelines (ingest, compile, query, search,
 * lint, read, status) as MCP tools so AI agents can drive the compiler
 * without scraping CLI output. Read-only wiki views are exposed as
 * MCP resources for direct context injection.
 *
 * Transport: stdio. The server reads JSON-RPC messages on stdin and
 * writes responses on stdout, which is the standard surface area for
 * Claude Desktop, Cursor, and other MCP-aware clients.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerWikiTools } from "./tools.js";
import { registerWikiResources } from "./resources.js";

interface ServerOptions {
  /** Project root directory the server operates on. */
  root: string;
  /** Server version surfaced to MCP clients in the initialize handshake. */
  version: string;
}

/**
 * Start the MCP server bound to stdio transport.
 * Resolves once the transport closes (typically when the parent process exits).
 *
 * @param options - Root directory and server version (the CLI passes its own
 *                  version so the server doesn't need to read package.json).
 */
export async function startMCPServer(options: ServerOptions): Promise<void> {
  const { root, version } = options;
  const server = new McpServer({ name: "llmwiki", version }, {
    instructions:
      "llmwiki is a knowledge compiler. Use ingest_source to add raw sources, " +
      "compile_wiki to run the LLM pipeline, query_wiki for grounded answers, " +
      "search_pages to retrieve relevant pages, and run_eval to score wiki quality. " +
      "read_page, lint_wiki, wiki_status, and run_eval (fast suite) work without an API key.",
  });

  registerWikiTools(server, root);
  registerWikiResources(server, root);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

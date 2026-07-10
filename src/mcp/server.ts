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
import { registerOkfTools } from "./okf-tools.js";
import { registerWorkflowActionTools } from "./workflow-action-tools.js";
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
      "read_page, lint_wiki, wiki_status, and run_eval (fast suite, record: false) work without an API key " +
      "and do not mutate state. " +
      "list_workflow_actions, describe_workflow_action, and run_workflow_action expose the workflow " +
      "harness; MCP actions are hard-capped at staged-write and cannot perform trusted writes or " +
      "satisfy human gates. " +
      "verify_artifact checks a hash-pinned artifact ref and returns manifest metadata plus a health " +
      "verdict, never the body; there is no write or store-wide list tool for artifacts over MCP.",
  });

  registerWikiTools(server, root);
  registerOkfTools(server, root);
  registerWorkflowActionTools(server, root);
  registerWikiResources(server, root);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

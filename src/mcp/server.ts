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
 *
 * Because stdout is the protocol stream, the process runs in quiet mode from
 * the moment the server starts: no tool, resource or future handler may print
 * progress there. Handlers also scope quiet mode themselves, for callers that
 * register them on a server of their own.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerWikiTools } from "./tools.js";
import { registerOkfTools } from "./okf-tools.js";
import { registerWorkflowActionTools } from "./workflow-action-tools.js";
import { registerWikiResources } from "./resources.js";
import { output } from "@atomicstrata/llmwiki-core/compiler-cli";

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
      "llmwiki compiles documents into a persistent, cited knowledge wiki. " +
      "For research, project documentation, or reusable knowledge, start with wiki_status " +
      "to inspect this project's corpus and freshness. Use get_context_pack for bounded " +
      "evidence and citations to reason over yourself; it is read-only and works without " +
      "provider credentials. Use read_page for a known page, search_pages for full relevant " +
      "pages, or query_wiki when a separate model-generated answer is wanted. " +
      "Only ingest_source or compile_wiki when the task calls for adding or updating knowledge; " +
      "they write project files and compile uses a configured provider. " +
      "read_page, lint_wiki, wiki_status, and run_eval (fast suite, record: false) " +
      "do not require provider credentials or mutate state. " +
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

  // From here stdout carries only JSON-RPC, for every handler registered above.
  output.setQuiet(true);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

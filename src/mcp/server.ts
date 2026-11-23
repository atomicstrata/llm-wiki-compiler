/**
 * MCP (Model Context Protocol) server entry point for llmwiki.
 *
 * Exposes llmwiki's automated pipelines (ingest, compile, query, search,
 * lint, read, status) as MCP tools so AI agents can drive the compiler
 * without scraping CLI output. Read-only wiki views are exposed as
 * MCP resources for direct context injection.
 *
 * Transport: stdio by default. The server reads JSON-RPC messages on stdin and
 * writes responses on stdout, which is the standard surface area for
 * Claude Desktop, Cursor, and other MCP-aware clients. With `http` it serves
 * streamable HTTP on loopback instead; see `http.ts`.
 *
 * Because stdout is the stdio protocol stream, the process runs in quiet mode
 * from the moment the server starts: no tool, resource or future handler may
 * print progress there. Handlers also scope quiet mode themselves, for callers
 * that register them on a server of their own.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerWikiTools } from "./tools.js";
import { registerOkfTools } from "./okf-tools.js";
import { registerWorkflowActionTools } from "./workflow-action-tools.js";
import { registerWikiResources } from "./resources.js";
import { output, type OpenSession } from "@atomicstrata/llmwiki-core/compiler-cli";
import { registerPortableScaleTools } from "./portable-scale-tools.js";
import { registerPortableTools } from "./portable-tools.js";
import { serveMcpOverHttp, type HttpServeOptions } from "./http.js";

interface ServerOptions {
  /** Project root directory the server operates on. */
  root: string;
  /** Server version surfaced to MCP clients in the initialize handshake. */
  version: string;
  /** Register only the tools that never write a project file. */
  readOnly?: boolean;
  /** Serve streamable HTTP on loopback instead of stdio. */
  http?: HttpServeOptions;
  /**
   * Serve a PORTABLE project instead of a directory. When set, only the
   * portable tools are registered; `root` and every legacy tool are unused.
   */
  portable?: OpenSession;
}

/** Instructions for a server bound to a portable project. */
const PORTABLE_INSTRUCTIONS =
  "This server exposes one llmwiki portable project. Use portable_list_pages, portable_read_page and " +
  "portable_search to read published pages; they use no model. portable_propose runs the compile in " +
  "review mode and persists a proposal; portable_list_candidates and portable_read_candidate show the " +
  "exact drafts. On a project whose store has a catalog, portable_list_pages_paged, portable_open_page and " +
  "portable_search_paged read one bounded page at a time. Every call is authorized as the server's configured principal. Approval and apply " +
  "are not available over MCP.";

/** Start the server for a portable project: portable tools only, never the legacy ones. */
async function startPortableServer(version: string, open: OpenSession): Promise<void> {
  const server = new McpServer({ name: "llmwiki", version }, { instructions: PORTABLE_INSTRUCTIONS });
  registerPortableTools(server, open);
  registerPortableScaleTools(server, open);
  // stdout carries only JSON-RPC from here on.
  output.setQuiet(true);
  await server.connect(new StdioServerTransport());
}

/** Build an MCP server with the tools and resources `options` asks for. */
function buildServer(options: ServerOptions): McpServer {
  const { root, version, readOnly } = options;
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

  registerWikiTools(server, root, readOnly);
  if (!readOnly) registerOkfTools(server, root);
  registerWorkflowActionTools(server, root, readOnly);
  registerWikiResources(server, root);
  return server;
}

/**
 * Start the MCP server on stdio, or on loopback HTTP when `options.http` is set.
 * Over stdio it resolves once the transport is connected; over HTTP, once the
 * port is bound.
 *
 * @param options - Root directory and server version (the CLI passes its own
 *                  version so the server doesn't need to read package.json),
 *                  plus the read-only and HTTP choices.
 */
export async function startMCPServer(options: ServerOptions): Promise<void> {
  if (options.portable) return startPortableServer(options.version, options.portable);
  // From here stdout carries only JSON-RPC, for every handler a server registers.
  output.setQuiet(true);
  if (options.http) return serveMcpOverHttp(() => buildServer(options), options.http);
  await buildServer(options).connect(new StdioServerTransport());
}

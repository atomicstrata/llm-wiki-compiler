/**
 * @file test/fixtures/mcp-test-server.ts
 * @description In-process MCP server for tests: `buildServer(root)` registers
 * every wiki tool and resource on a fresh `McpServer`, and `callTool` invokes a
 * registered handler directly, without a stdio transport.
 *
 * Split from `mcp-test-env.ts` (temp roots and the stdio client) because the
 * wiki tools load most of the source tree, and Bun loads each test file's import
 * graph afresh: the stdio-only tests should not pay for a server they never
 * build.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWikiTools } from "../../src/mcp/tools.js";
import { registerWikiResources } from "../../src/mcp/resources.js";

/**
 * Build a fresh McpServer with the wiki tools and resources registered.
 *
 * Intentionally registers ONLY the wiki tools/resources, NOT the OKF tools
 * (export_okf/import_okf): in-process OKF coverage drives `registerOkfTools`
 * directly with a fake server, and OKF stdio coverage uses the real `serve`
 * binary via `connectMcpClient`. A future reader reaching for `buildServer`
 * to call an OKF tool would get "tool not found" — by design.
 */
export function buildServer(root: string): McpServer {
  const server = new McpServer({ name: "llmwiki-test", version: "0.0.0" });
  registerWikiTools(server, root);
  registerWikiResources(server, root);
  return server;
}

/** MCP envelope shape returned by every registered tool handler. */
export interface McpToolEnvelope {
  content: Array<{ type: string; text: string }>;
  structuredContent?: { result: unknown };
  /** Present + `true` when the handler reports a clean tool-level error. */
  isError?: boolean;
}

/**
 * Invoke a registered tool's handler directly. Mirrors what an MCP
 * client would do over stdio without paying the transport setup cost.
 */
export async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolEnvelope> {
  const tools = (server as unknown as {
    _registeredTools: Record<
      string,
      { handler: (a: Record<string, unknown>) => Promise<unknown> }
    >;
  })._registeredTools;
  const tool = tools[name];
  return tool.handler(args) as Promise<McpToolEnvelope>;
}

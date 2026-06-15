/**
 * @file Shared in-process harness for the MCP OKF tools.
 *
 * Both the OKF tool suite and the queue-cap test register `registerOkfTools`
 * against a fake `McpServer` that just captures each tool's handler by name.
 * The precise `ToolHandler` type means a drift in the result envelope fails at
 * tsc rather than silently at runtime.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOkfTools } from "../../src/mcp/okf-tools.js";

/** A registered tool handler's call signature — drift in the result envelope fails at tsc. */
export type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: true }>;

/**
 * Register the OKF tools against a fake server and return their handlers by name.
 * `maxPending` is forwarded so a test can inject a cap (e.g. 0) to prove it is wired.
 */
export function collectOkfHandlers(root: string, maxPending?: number): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const fake = {
    registerTool: (name: string, _def: unknown, handler: ToolHandler) => handlers.set(name, handler),
  } as unknown as McpServer;
  if (maxPending === undefined) registerOkfTools(fake, root);
  else registerOkfTools(fake, root, maxPending);
  return handlers;
}

/**
 * Streamable HTTP transport for the llmwiki MCP server.
 *
 * Binds loopback only: a reverse proxy or tunnel is what publishes it. With a
 * bearer token, every request must carry `Authorization: Bearer <token>` and is
 * refused with 401 before its path, method or body is looked at. Without one,
 * the proxy owns authentication (an OAuth proxy sends its own `Authorization`,
 * so the two cannot be combined) and the listener admits only requests that
 * name its own loopback address as `Host`, which a proxy sets and a web page
 * reaching the port through DNS rebinding cannot.
 *
 * The transport is stateless: no session ids, and a fresh server and transport
 * per request, which the SDK requires of a stateless transport. A client POSTs
 * JSON-RPC to `/mcp`; with no sessions there is no stream to GET or DELETE.
 */

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const LOOPBACK_HOST = "127.0.0.1";
const MCP_PATH = "/mcp";

/** Where the HTTP transport listens and what admits a request. */
export interface HttpServeOptions {
  /** Loopback port to bind. */
  port: number;
  /** Bearer token every request must present; without one, only a loopback `Host` is admitted. */
  token?: string;
}

/** Digest a token so two of any length compare in constant time. */
function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** True when the request's `Authorization` header is `Bearer <token>`. */
function presentsToken(req: IncomingMessage, token: string): boolean {
  const [scheme, presented] = (req.headers.authorization ?? "").split(" ");
  return scheme === "Bearer" && presented !== undefined && timingSafeEqual(digest(presented), digest(token));
}

/** True when the request names this listener's own loopback address as `Host`. */
function namesLoopbackHost(req: IncomingMessage): boolean {
  const port = req.socket.localPort;
  return req.headers.host === `${LOOPBACK_HOST}:${port}` || req.headers.host === `localhost:${port}`;
}

/** End the response with a status and a one-line JSON error. */
function refuse(res: ServerResponse, status: number, error: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ error }));
}

/** Answer one JSON-RPC POST on a server and transport of its own. */
async function answer(buildServer: () => McpServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

/**
 * Serve MCP over streamable HTTP on loopback until the process exits.
 *
 * @param buildServer - Builds the MCP server that answers one request.
 * @param options - The port to bind and the token to require, if any.
 */
export async function serveMcpOverHttp(buildServer: () => McpServer, options: HttpServeOptions): Promise<void> {
  const listener = http.createServer((req, res) => {
    if (options.token === undefined) {
      if (!namesLoopbackHost(req)) return refuse(res, 403, "forbidden host");
    } else if (!presentsToken(req, options.token)) {
      return refuse(res, 401, "unauthorized", { "WWW-Authenticate": "Bearer" });
    }
    if (req.url !== MCP_PATH) return refuse(res, 404, "not found");
    if (req.method !== "POST") return refuse(res, 405, "method not allowed", { Allow: "POST" });
    answer(buildServer, req, res).catch((err: unknown) => {
      if (res.headersSent) res.end();
      else refuse(res, 500, err instanceof Error ? err.message : String(err));
    });
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(options.port, LOOPBACK_HOST, resolve);
  });
  const { port } = listener.address() as AddressInfo;
  console.error(`llmwiki MCP server listening on http://${LOOPBACK_HOST}:${port}${MCP_PATH}`);
}

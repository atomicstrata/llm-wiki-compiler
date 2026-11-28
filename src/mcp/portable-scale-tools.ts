/**
 * @file src/mcp/portable-scale-tools.ts
 * @description MCP tools for the paged reads of a portable project (slice S1):
 * one listing page, one opened page and one bounded keyword search.
 *
 * They sit beside the version 1 portable tools and change none of them. Each
 * call goes through the shared paged surface, so it opens a session from the
 * server's configured credential and is decided against current host state. No
 * tool takes a principal, a role or a label, and all three are reads.
 *
 * A project whose store has no catalog answers `capability_unsupported`; an
 * agent then uses the version 1 tools, knowingly. Nothing falls back silently.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pagedSurface, withQuiet, type OpenSession } from "@atomicstrata/llmwiki-core/compiler-cli";
import { errorResult, jsonResult } from "./result.js";

/** Run one paged read quietly. A refusal is a result an agent can act on, marked as an error. */
function answer(run: () => Promise<{ kind: string }>) {
  return withQuiet(async () => {
    const outcome = await run();
    return outcome.kind === "refused" || outcome.kind === "not_visible"
      ? errorResult(JSON.stringify(outcome)) : jsonResult(outcome);
  });
}

/** Register the paged read tools on `server`, bound to one way of opening sessions. */
export function registerPortableScaleTools(server: McpServer, open: OpenSession): void {
  const surface = pagedSurface(open);
  server.registerTool("portable_list_pages_paged", {
    title: "List Portable Pages (Paged)",
    description:
      "One page of this portable project's published pages, from a sorted catalog. Reads no page body. Pass the " +
      "returned cursor to get the next page; a stale_cursor refusal means start again without one.",
    inputSchema: {
      cursor: z.string().optional().describe("The cursor from the previous page, unchanged"),
      limit: z.number().int().positive().optional().describe("Page size; the host caps it"),
    },
  }, ({ cursor, limit }) => answer(() => surface.listPage({ cursor, limit })));
  server.registerTool("portable_open_page", {
    title: "Open Portable Page",
    description: "Open one published page by id: its metadata is checked first and only then its body is read.",
    inputSchema: { id: z.string().describe("Page id from a listing or a search hit") },
  }, ({ id }) => answer(() => surface.openPage(id)));
  server.registerTool("portable_search_paged", {
    title: "Search Portable Pages (Bounded)",
    description:
      "Keyword search over published pages under a declared scan budget. Uses no model and no embeddings. " +
      "truncated=true means the budget ended the scan and matches may be missing; availability=index_behind " +
      "means some readable pages were not searched yet.",
    inputSchema: {
      query: z.string().describe("Keywords; every term must match"),
      limit: z.number().int().positive().optional().describe("Most hits to return; the host caps it"),
    },
  }, ({ query, limit }) => answer(() => surface.search({ text: query, limit })));
}

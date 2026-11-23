/**
 * @file src/mcp/portable-tools.ts
 * @description MCP tools for a portable project: page list, page read, keyword
 * search, propose, and candidate review reads.
 *
 * When the server is started for a portable project these are the ONLY tools
 * registered. The legacy wiki tools act on a directory as a local operator and
 * know nothing of a principal, so they are never offered beside these and are
 * never used as a fallback.
 *
 * Each call goes through the shared portable surface: it opens a session from
 * the server's configured credential and is authorized against current host
 * state. No tool takes a principal, a role or a label. There is no approve and
 * no apply tool: an agent can read and propose, and a person decides.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  portableSurface, surfaceFailure, withQuiet, type OpenSession, type PortableSurface,
} from "@atomicstrata/llmwiki-core/compiler-cli";
import { errorResult, jsonResult } from "./result.js";

/** Run one surface operation quietly and shape its result, or its disclosed failure. */
function answer(run: () => Promise<unknown>) {
  return withQuiet(async () => {
    try {
      return jsonResult(await run());
    } catch (error) {
      return errorResult(JSON.stringify(surfaceFailure(error)));
    }
  });
}

/** Register the read tools. */
function registerReadTools(server: McpServer, surface: PortableSurface): void {
  server.registerTool("portable_list_pages", {
    title: "List Portable Pages",
    description: "List the published pages of this portable project that the configured principal may read.",
    inputSchema: {},
  }, () => answer(() => surface.listPages()));
  server.registerTool("portable_read_page", {
    title: "Read Portable Page",
    description: "Read one published page of this portable project by id.",
    inputSchema: { id: z.string().describe("Page id, for example tidal-energy") },
  }, ({ id }) => answer(() => surface.readPage(id)));
  server.registerTool("portable_search", {
    title: "Search Portable Pages",
    description: "Deterministic keyword search over published pages. Uses no model and no embeddings.",
    inputSchema: { query: z.string().describe("Keywords to search for") },
  }, ({ query }) => answer(() => surface.search(query)));
}

/** Register the propose and review-read tools. */
function registerProposeTools(server: McpServer, surface: PortableSurface): void {
  server.registerTool("portable_allocate_operation", {
    title: "Allocate Portable Operation",
    description:
      "Allocate an operation id BEFORE proposing. Keep it: it is how you ask what happened if a " +
      "response is lost, and how you retry without creating a second proposal.",
    inputSchema: {},
  }, () => answer(async () => ({ operationId: await surface.allocateOperation() })));
  server.registerTool("portable_operation_status", {
    title: "Portable Operation Status",
    description: "Report the recorded outcome of an operation by the id you kept. not_found never permits a new id.",
    inputSchema: { operationId: z.string().describe("The operation id you allocated") },
  }, ({ operationId }) => answer(() => surface.status(operationId)));
  server.registerTool("portable_propose", {
    title: "Propose Portable Changes",
    description:
      "Run the compile in review mode inside the host and persist a proposal for human review, under an " +
      "operation id you allocated first. To retry after a lost or unknown response, call again with the " +
      "SAME id. Writes no page. Approval and apply are not available over MCP.",
    inputSchema: {
      operationId: z.string().describe("From portable_allocate_operation; reuse it to retry"),
      supersedes: z.string().optional().describe("A refused operation this new request replaces"),
    },
  }, ({ operationId, supersedes }) => answer(() => surface.propose(operationId, supersedes)));
  server.registerTool("portable_list_candidates", {
    title: "List Proposal Candidates",
    description: "List the candidates of one proposal.",
    inputSchema: { proposal: z.string().describe("Proposal operation id") },
  }, ({ proposal }) => answer(() => surface.listCandidates(proposal)));
  server.registerTool("portable_read_candidate", {
    title: "Read Proposal Candidate",
    description: "Read one candidate in full: the exact draft that would be written and what it would replace.",
    inputSchema: {
      proposal: z.string().describe("Proposal operation id"),
      candidate: z.string().describe("Candidate id"),
    },
  }, ({ proposal, candidate }) => answer(() => surface.readCandidate(proposal, candidate)));
}

/** Register every portable tool on `server`, bound to one way of opening sessions. */
export function registerPortableTools(server: McpServer, open: OpenSession): void {
  const surface = portableSurface(open);
  registerReadTools(server, surface);
  registerProposeTools(server, surface);
}

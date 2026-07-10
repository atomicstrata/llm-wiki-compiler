/**
 * @file src/mcp/workflow-action-tools.ts
 * @description MCP tool registrations exposing the workflow-action harness.
 *
 * Three thin wrappers over the EXISTING action core — `listActions` / `showAction`
 * (read-only discovery) and `runAction` (execution) — adding NO new authority
 * logic. Every invocation flows through `runAction` with the surface HARDCODED to
 * `"mcp"`: a client can never pass or override the surface to claim a higher-cap
 * surface (cli/sdk). The `"mcp"` surface is hard-capped at `staged-write` by the
 * authority model, so an action requesting `trusted-write` or satisfying a `human:`
 * gate over MCP is DENIED before any op runs — surfaced here as a clean MCP error
 * result, never a crash. Any typed core error (denied/unknown/invalid/unavailable/
 * lock-busy) is funnelled through {@link runToolSafely} into {@link errorResult}.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listActions, showAction } from "../workflows/actions.js";
import { runAction } from "../workflows/run-action.js";
import { workflowStatus } from "../workflows/status.js";
import { assertRawInputJsonWithinBounds, assertInputDepthWithinBounds } from "../workflows/input-bounds.js";
import { jsonResult, errorResult } from "./result.js";

/** The surface every MCP-invoked action runs under — HARDCODED, never client-derived. */
const MCP_SURFACE = "mcp" as const;

/** The MCP result envelope a tool handler returns (success xor error). */
type ToolResult = ReturnType<typeof jsonResult> | ReturnType<typeof errorResult>;

/**
 * Run a tool body, converting ANY thrown error into a clean {@link errorResult}
 * (`isError: true`) so a denied/unknown/invalid action returns a structured MCP
 * error rather than crashing the transport. Used by the throwing tools so the
 * try/catch lives in exactly one place.
 *
 * @param fn - The tool body producing a success result.
 * @returns The body's result, or an error result carrying the thrown message.
 */
async function runToolSafely(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

/** Register `list_workflow_actions` — read-only enumeration of declared actions. */
function registerListTool(server: McpServer, root: string): void {
  server.registerTool(
    "list_workflow_actions",
    {
      title: "List Workflow Actions",
      description:
        "List the workflow actions declared by the active profile (id, label, " +
        "workflow, operation). Read-only; takes no lock and mutates nothing.",
      inputSchema: {},
    },
    async () => jsonResult(await listActions(root)),
  );
}

/** Register `describe_workflow_action` — one action's detail + per-surface permissions. */
function registerDescribeTool(server: McpServer, root: string): void {
  server.registerTool(
    "describe_workflow_action",
    {
      title: "Describe Workflow Action",
      description:
        "Describe one declared workflow action, including its EFFECTIVE permission " +
        "per surface = min(profile request, local grant, surface cap). The `mcp` " +
        "surface is hard-capped at staged-write. Read-only.",
      inputSchema: { actionId: z.string().describe("The declared action id to describe.") },
    },
    async ({ actionId }) => runToolSafely(async () => jsonResult(await showAction(root, actionId))),
  );
}

/** Register `run_workflow_action` — execute an action ALWAYS under the `mcp` surface. */
function registerRunTool(server: McpServer, root: string): void {
  server.registerTool(
    "run_workflow_action",
    {
      title: "Run Workflow Action",
      description:
        "Execute a declared workflow action. MCP actions are HARD-CAPPED at " +
        "staged-write: they CANNOT perform trusted writes or satisfy human gates, " +
        "regardless of what a profile or local config requests. A denied, unknown, " +
        "or invalid action returns a clean error result rather than crashing.",
      inputSchema: {
        actionId: z.string().describe("The declared action id to execute."),
        inputs: z.record(z.string(), z.unknown()).optional().describe("The action's inputs, validated against its schema."),
      },
    },
    async ({ actionId, inputs }) =>
      runToolSafely(async () => {
        const payload = inputs ?? {};
        // BOUND the unbounded `z.record` payload BEFORE runAction materializes it.
        // DEPTH FIRST: the depth guard short-circuits on excessive nesting, so it
        // must run BEFORE JSON.stringify (which would itself overflow on a deep
        // object). Then bound the raw serialized size (memory DoS).
        assertInputDepthWithinBounds(payload);
        assertRawInputJsonWithinBounds(JSON.stringify(payload));
        return jsonResult(await runAction(root, actionId, payload, MCP_SURFACE));
      }),
  );
}

/**
 * Register `workflow_run_status` — read-only run observability over MCP. Reports
 * one run (by `runId`) or all runs, classified against the active profile, via the
 * fail-visible {@link workflowStatus} — so an unavailable/corrupt store surfaces a
 * `problem` row rather than an empty list, and the same redaction applies. No
 * mutation, no lock.
 */
function registerRunStatusTool(server: McpServer, root: string): void {
  server.registerTool(
    "workflow_run_status",
    {
      title: "Workflow Run Status",
      description:
        "Report the status of one workflow run (by runId) or of all runs, classified " +
        "against the active profile (current / historical / needs-adaptation / " +
        "blocked-by-config). Read-only and fail-visible: an unavailable store surfaces a " +
        "problem row, never an empty result. Takes no lock and mutates nothing.",
      inputSchema: { runId: z.string().optional().describe("A run id to report on; omit for all runs.") },
    },
    async ({ runId }) => runToolSafely(async () => jsonResult(await workflowStatus(root, runId))),
  );
}

/**
 * Register the workflow-action + run-observability MCP tools on `server`, bound to
 * `root`.
 *
 * @param server - The MCP server to register the tools on.
 * @param root - Absolute project root the tools operate on.
 */
export function registerWorkflowActionTools(server: McpServer, root: string): void {
  registerListTool(server, root);
  registerDescribeTool(server, root);
  registerRunTool(server, root);
  registerRunStatusTool(server, root);
}

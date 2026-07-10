/**
 * @file test/mcp-stdio-workflow.test.ts
 * @description Real MCP-over-stdio integration for the workflow-action tools.
 *
 * Spawns the actual `llmwiki serve --root <tmp>` binary, connects an SDK Client via
 * StdioClientTransport, and drives `list_workflow_actions` + `run_workflow_action`
 * through the full JSON-RPC `tools/call` path (no in-process shortcut) over a seeded
 * profile. Confirms the tools are reachable end-to-end and that a `start` action
 * mints a run under the hard-capped `mcp` surface (staged-write). Mirrors the
 * `wiki_status` stdio test; the server runs `dist/`, so build before running.
 */

import { describe, it, expect } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { useMcpRoot, connectMcpClient, parseToolPayload } from "./fixtures/mcp-test-env.js";
import { installRunActionProfile } from "./fixtures/run-action-profile.js";

const rootHandle = useMcpRoot("mcp-stdio-wf");

describe("MCP stdio: workflow-action tools", () => {
  it("lists actions and runs a start action through the real tools/call path", async () => {
    const root = rootHandle.value;
    await installRunActionProfile(root);
    const { client, transport } = await connectMcpClient(root);
    try {
      const listed = await client.callTool({ name: "list_workflow_actions", arguments: {} });
      const actions = parseToolPayload<Array<{ actionId: string }>>(listed as CallToolResult);
      expect(actions.map((a) => a.actionId)).toContain("build.start");

      const ran = await client.callTool({ name: "run_workflow_action", arguments: { actionId: "build.start" } });
      const out = parseToolPayload<{ effectivePermission: string; result: { runId: string } }>(ran as CallToolResult);
      expect(out.effectivePermission).toBe("staged-write");
      expect(out.result.runId).toMatch(/.+/);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});

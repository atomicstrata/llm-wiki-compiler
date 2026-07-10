/**
 * @file test/mcp-workflow-action-tools.test.ts
 * @description In-process coverage for the 3 workflow-action MCP tools.
 *
 * Registers `registerWorkflowActionTools` on a bare test `McpServer`, invokes the
 * registered handlers directly (no transport), and asserts the surface contract:
 * `list_workflow_actions` enumerates the profile's actions; `describe_workflow_action`
 * computes effective permissions with the `mcp` surface clamped to `staged-write`;
 * `run_workflow_action` mints a run for a `start` action but DENIES a `human:`-gate
 * action (the cap can never satisfy a human gate) — returned as a clean MCP error,
 * never a crash; and an unknown action id is a clean error result.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWorkflowActionTools } from "../src/mcp/workflow-action-tools.js";
import { installRunActionProfile } from "./fixtures/run-action-profile.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { callTool as call } from "./fixtures/mcp-test-env.js";

const ctx = useConfinementRoots("mcp-wf-action");

/** A fresh server with only the workflow-action tools registered, over an installed profile. */
async function setup(root: string): Promise<McpServer> {
  await installRunActionProfile(root);
  const server = new McpServer({ name: "t", version: "0" });
  registerWorkflowActionTools(server, root);
  return server;
}

describe("MCP workflow-action tools (in-process)", () => {
  let server: McpServer;
  beforeEach(async () => { server = await setup(ctx.root); });
  afterEach(async () => { await rm(ctx.root, { recursive: true, force: true }); });

  it("list_workflow_actions returns the declared actions", async () => {
    const res = await call(server, "list_workflow_actions", {});
    const ids = (res.structuredContent?.result as Array<{ actionId: string }>).map((a) => a.actionId);
    expect(ids).toContain("build.start");
    expect(ids).toContain("gatehuman.approve");
  });

  it("describe_workflow_action clamps the human-gate action's mcp permission to ≤ staged-write", async () => {
    const res = await call(server, "describe_workflow_action", { actionId: "gatehuman.approve" });
    const detail = res.structuredContent?.result as { effectivePermissions: Record<string, string> };
    expect(detail.effectivePermissions.mcp).toBe("staged-write");
  });

  it("run_workflow_action mints a run for a staged-write start action", async () => {
    const res = await call(server, "run_workflow_action", { actionId: "build.start" });
    expect(res.isError).toBeUndefined();
    const out = res.structuredContent?.result as { effectivePermission: string; result: { runId: string } };
    expect(out.effectivePermission).toBe("staged-write");
    expect(out.result.runId).toMatch(/.+/);
  });

  it("run_workflow_action DENIES a human-gate action (mcp cap) as an MCP error, never satisfied", async () => {
    const res = await call(server, "run_workflow_action", { actionId: "gatehuman.approve", inputs: { runId: "anything" } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('denied on surface "mcp"');
    expect(res.content[0].text).toContain("human gate");
  });

  it("run_workflow_action on an unknown action id returns a clean error result", async () => {
    const res = await call(server, "run_workflow_action", { actionId: "ghost" });
    expect(res.isError).toBe(true);
  });

  it("run_workflow_action rejects OVERSIZE inputs as a clean error (no crash/DoS)", async () => {
    const inputs = { v: "x".repeat(70 * 1024) }; // > 64 KiB serialized
    const res = await call(server, "run_workflow_action", { actionId: "build.start", inputs });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/exceeds the cap|rejected|too large/i);
  });

  it("run_workflow_action rejects DEEPLY-NESTED inputs as a clean error (no overflow)", async () => {
    let nested: unknown = 1;
    for (let i = 0; i < 50; i++) nested = { a: nested };
    const res = await call(server, "run_workflow_action", { actionId: "build.start", inputs: nested as Record<string, unknown> });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/nesting|depth|rejected/i);
  });

  it("describe_workflow_action on an unknown id returns a clean error result", async () => {
    const res = await call(server, "describe_workflow_action", { actionId: "ghost" });
    expect(res.isError).toBe(true);
  });

  it("workflow_run_status returns run status (read-only), surfacing a started run", async () => {
    await call(server, "run_workflow_action", { actionId: "build.start" });
    const res = await call(server, "workflow_run_status", {});
    expect(res.isError).toBeUndefined();
    const rows = res.structuredContent?.result as Array<{ runId: string; classification: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });

  it("workflow_run_status surfaces a problem for a corrupt run record (not empty)", async () => {
    const runsDir = path.join(ctx.root, ".llmwiki", "workflows", "runs");
    await mkdir(runsDir, { recursive: true });
    await writeFile(path.join(runsDir, "build-corrupt.json"), "{ not valid json", "utf8");
    const res = await call(server, "workflow_run_status", {});
    expect(res.isError).toBeUndefined();
    const rows = res.structuredContent?.result as Array<{ problem?: string }>;
    expect(rows.some((r) => r.problem !== undefined)).toBe(true);
  });
});

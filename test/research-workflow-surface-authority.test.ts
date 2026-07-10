/**
 * @file test/research-workflow-surface-authority.test.ts
 * @description The per-surface authority matrix for the research workflow actions:
 * MCP is hard-capped at staged-write (it runs `research.check`/`research.begin` but
 * the human-gate `review-response.approve` action is DENIED), the `sdk` surface
 * denies the same human gate programmatically, and a human gate is satisfiable
 * ONLY via interactive cli confirmation. Composes the landed authority model
 * (`src/workflows/authority.ts` + `src/workflows/run-action.ts`) — asserts it,
 * never forks it.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { installResearchProfile } from "./fixtures/research-profile.js";
import { runAction } from "../src/workflows/run-action.js";
import { ActionDeniedError } from "../src/workflows/errors.js";
import { registerWorkflowActionTools } from "../src/mcp/workflow-action-tools.js";
import { callTool as call } from "./fixtures/mcp-test-env.js";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "wf-surface-auth-"));
  await installResearchProfile(root);
});
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("mcp surface — hard-capped at staged-write", () => {
  it("denies the human-gate action on mcp", async () => {
    await expect(runAction(root, "review-response.approve", { runId: "x" }, "mcp"))
      .rejects.toBeInstanceOf(ActionDeniedError);
  });
});

describe("mcp surface — staged-write ops still flow", () => {
  it("runs research.check (status) and research.begin (start) over mcp", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerWorkflowActionTools(server, root);
    const status = await call(server, "run_workflow_action", { actionId: "research.check" });
    expect(status.isError).toBeUndefined();
    const started = await call(server, "run_workflow_action", { actionId: "research.begin" });
    expect(started.isError).toBeUndefined();
    const runId = (started.structuredContent?.result as { result: { runId: string } }).result.runId;
    expect(runId).toMatch(/.+/);
  });
});

describe("human gate — never satisfiable programmatically", () => {
  it("denies review-response.approve on sdk (no interactive proof possible)", async () => {
    await expect(runAction(root, "review-response.approve", { runId: "x" }, "sdk"))
      .rejects.toBeInstanceOf(ActionDeniedError);
  });
});

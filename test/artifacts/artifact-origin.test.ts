/**
 * @file test/artifacts/artifact-origin.test.ts
 * @description F2: the artifact-write audit event carries the widened provenance
 * origin. A workflow-produced artifact is attributed "workflow" (and an
 * MCP-triggered workflow action "workflow-mcp") — distinct from the direct
 * "cli"/"sdk" #9A writes — proving the origin model accepts the new values at the
 * executor/event layer BEFORE the workflow arm is wired.
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeResearchLikeRoot } from "../fixtures/artifact-root.js";
import { applyApprovedMutations } from "../../src/trust/executor.js";
import { readEvents } from "../../src/events/store-read.js";

afterEach(() => { delete process.env.LLMWIKI_TRUSTED_WRITE; });

describe("artifact-write event origin (F2)", () => {
  it("records a 'workflow' origin for a workflow-produced artifact", async () => {
    const root = await makeResearchLikeRoot("artifact-origin-wf");
    process.env.LLMWIKI_TRUSTED_WRITE = "*";
    await applyApprovedMutations(root, [{ kind: "artifact", artifactType: "experiment-result", slug: "p", body: `{"accuracy":0.9}`, origin: "workflow" }]);
    const ev = (await readEvents(root)).events.at(-1) as { type?: string; origin?: string };
    expect(ev.type).toBe("artifact-write");
    expect(ev.origin).toBe("workflow");
  });

  it("records a 'workflow-mcp' origin, distinct from cli/sdk", async () => {
    const root = await makeResearchLikeRoot("artifact-origin-mcp");
    process.env.LLMWIKI_TRUSTED_WRITE = "*";
    await applyApprovedMutations(root, [{ kind: "artifact", artifactType: "experiment-result", slug: "p", body: `{"accuracy":0.9}`, origin: "workflow-mcp" }]);
    const ev = (await readEvents(root)).events.at(-1) as { origin?: string };
    expect(ev.origin).toBe("workflow-mcp");
  });
});

/**
 * @file test/workflow-action-artifact-origin.test.ts
 * @description Covers ALL THREE artifact-write trigger surfaces required by spec
 * §61/§63 — SDK (`createWiki().submitStageOutput`), and the cli/mcp submit ACTION —
 * and the surface-stamped origin: cli/sdk → "workflow", mcp → "workflow-mcp"
 * (net-new F2 granularity, not spoofable to cli/sdk). MCP without the operator
 * grant stays refused; WITH the grant it applies and is attributed "workflow-mcp".
 * Includes an origin-FORGERY test: a bogus `origin` action input is DROPPED.
 */
import { describe, it, expect, afterEach } from "vitest";
import { researchArtifactProfile, startArtifactRun, resultOutput, grantTrustedWrite, readArtifactEventOrigin } from "./fixtures/artifact-seam-fixtures.js";
import { createWiki } from "../src/index.js";
import { runAction } from "../src/workflows/run-action.js";
import { readRun } from "../src/workflows/store.js";
import { TRUSTED_WRITE_ENV_VAR } from "../src/workflows/trusted-write.js";
import type { ProfilePack } from "../src/profile/types.js";

afterEach(() => { delete process.env[TRUSTED_WRITE_ENV_VAR]; });

/** The research profile + a `build.result` artifact submit action (all-surfaces staged-write). */
function actionProfile(): ProfilePack {
  const p = researchArtifactProfile("trust:high") as ProfilePack & { workflowActions?: unknown };
  p.workflowActions = { "build.result": {
    label: "Submit result", workflow: "build", operation: "submit",
    permissions: { cli: "trusted-write", sdk: "trusted-write", mcp: "staged-write", viewer: "disabled" },
    trustGate: "trust:high",
    inputSchema: { runId: { type: "string", required: true }, artifactType: { type: "string", required: true }, slug: { type: "string", required: true }, body: { type: "string", required: true } },
  } };
  return p;
}

// startArtifactRun already writes PROFILE_FILE with the passed profile — no second write.
const seed = (prefix: string) => startArtifactRun(prefix, actionProfile());

describe("artifact submit surfaces + origin (F2)", () => {
  it("SDK: createWiki().submitStageOutput records a 'workflow' origin (spec §61/§63 SDK surface)", async () => {
    const { root, runId, profileId } = await seed("art-sdk");
    grantTrustedWrite(profileId);
    const wiki = createWiki({ root });
    const result = await wiki.submitStageOutput(runId, resultOutput("exp-sdk"));
    expect(result.applied).toBe(true);
    expect(await readArtifactEventOrigin(root)).toBe("workflow");
  });

  it("attributes an mcp-triggered artifact write distinctly as 'workflow-mcp'", async () => {
    const { root, runId, profileId } = await seed("art-act-mcp");
    grantTrustedWrite(profileId);
    await runAction(root, "build.result", { runId, artifactType: "experiment-result", slug: "exp-1", body: `{"accuracy":0.9}` }, "mcp");
    expect(await readArtifactEventOrigin(root)).toBe("workflow-mcp");
  });

  it("attributes a cli-triggered artifact write as 'workflow'", async () => {
    const { root, runId, profileId } = await seed("art-act-cli");
    grantTrustedWrite(profileId);
    await runAction(root, "build.result", { runId, artifactType: "experiment-result", slug: "exp-2", body: `{"accuracy":0.9}` }, "cli");
    expect(await readArtifactEventOrigin(root)).toBe("workflow");
  });

  it("REJECTS a forged `origin` action input — the input allowlist bars it, nothing written", async () => {
    const { root, runId, profileId } = await seed("art-act-forge");
    grantTrustedWrite(profileId);
    // Adversary adds an `origin: "cli"` input to steer provenance. `validateActionInputs`
    // rejects any key not in `inputSchema` (unknown input), so origin can NEVER be
    // caller-supplied through the action surface — the harness alone derives it.
    await expect(runAction(root, "build.result", { runId, artifactType: "experiment-result", slug: "exp-3", body: `{"accuracy":0.9}`, origin: "cli" }, "mcp"))
      .rejects.toThrow(/unknown input/);
    expect(await readArtifactEventOrigin(root)).toBeUndefined(); // nothing recorded
  });

  it("mcp WITHOUT the grant is refused (run→failed), no artifact write recorded", async () => {
    const { root, runId } = await seed("art-act-mcp-nogrant");
    await expect(runAction(root, "build.result", { runId, artifactType: "experiment-result", slug: "exp-4", body: `{"accuracy":0.9}` }, "mcp"))
      .rejects.toThrow(/LLMWIKI_TRUSTED_WRITE/);
    const read = await readRun(root, runId);
    expect(read.status === "ok" && read.run.status).toBe("failed");
    expect(await readArtifactEventOrigin(root)).toBeUndefined();
  });
});

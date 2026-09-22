/**
 * @file test/workflow-human-input.test.ts
 * @description Behavioral witnesses for the closed workflow human-input
 * grammar. They prove all six field forms settle through the generic stage
 * output boundary while caller-controlled envelope fields, foreign references,
 * stale lifecycle state, and malformed payload shapes fail closed.
 */

import { describe, expect, it, vi } from "vitest";
import { createLocalWorkflowHost } from "../src/local-workflow-host/index.js";
import { createLocalWorkflowRuntime } from "../src/workflows/runtime.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { seedArtifact } from "./fixtures/artifact-seed.js";
import { installWorkflowProfile } from "./fixtures/workflow-profile.js";
import { startWorkflow } from "../src/workflows/start.js";
import { submitStageOutput } from "../src/workflows/stage-output.js";
import { HumanInputValidationError } from "../src/workflows/human-input-schema.js";
import { readRun } from "../src/workflows/store.js";
import { advanceWorkflow } from "../src/workflows/advance.js";
import { workflowStatus } from "../src/workflows/status.js";
import { canonicalDigest } from "../src/profile/templates/signing/canonical.js";
import { showWorkflow } from "../src/workflows/show.js";
import type { ProfilePack } from "../src/profile/types.js";

const stage = {
  id: "frame", reads: ["desks"], writes: [],
  humanInput: {
    schemaVersion: 1 as const, schemaId: "newsroom/story-frame-v1",
    fields: {
      angle: { kind: "string" as const, maxBytes: 80, required: true },
      desk: { kind: "entity-ref" as const, entityTypes: ["desks"], lifecycleStates: ["active"], allowedInput: "desks", required: true },
      format: { kind: "enum" as const, values: ["brief", "feature"], default: "brief" },
      evidence: { kind: "artifact-ref" as const, artifactTypes: ["source"], allowedInput: "sources", required: true },
      notes: { kind: "string-list" as const, maxItems: 3, maxItemBytes: 24, default: [] },
      related: { kind: "ref-list" as const, referenceKind: "entity" as const, entityTypes: ["desks"], lifecycleStates: ["active"], allowedInput: "desks", maxItems: 2 },
    },
  },
};

function profile(): ProfilePack {
  return {
    schemaVersion: 1, profileId: "newsroom-human-input",
    entities: {
      desks: {
        directory: "wiki/desks", fields: { stage: { type: "enum", enum: ["active", "closed"] } },
        lifecycle: { field: "stage", initial: "active", terminal: ["closed"], transitions: { active: ["closed"] } },
      },
    },
    artifacts: { source: { fileName: "source.txt", contentKind: "text", maxBytes: 1024 } },
    workflows: { story: { stages: [stage] } },
  };
}

async function fixture() {
  const root = await makeTempRoot("workflow-human-input");
  await installWorkflowProfile(root, profile());
  await mkdir(path.join(root, "wiki/desks"), { recursive: true });
  await writeFile(path.join(root, "wiki/desks/science.md"), "---\nstage: active\n---\nScience\n", "utf8");
  await writeFile(path.join(root, "wiki/desks/politics.md"), "---\nstage: active\n---\nPolitics\n", "utf8");
  await writeFile(path.join(root, "wiki/desks/closed.md"), "---\nstage: closed\n---\nClosed\n", "utf8");
  const source = await seedArtifact(root, "source", "source.txt", "report", "retained source", "text");
  const outsideSource = await seedArtifact(root, "source", "source.txt", "other", "other source", "text");
  const run = await startWorkflow(root, "story", { desks: ["desks/science", "desks/closed"], sources: [source] });
  return { root, run, source, outsideSource };
}

function validInput(source: string): Record<string, unknown> {
  return { angle: "Follow the evidence", desk: "desks/science", evidence: source, related: ["desks/science"] };
}

describe("workflow human input", () => {
  it("resolves references and records settlement through the supplied host", async () => {
    const { root, run, source } = await fixture();
    const base = createLocalWorkflowHost();
    const artifact = vi.fn(base.observations.artifact);
    const entityFrontmatter = vi.fn(base.observations.entityFrontmatter);
    const write = vi.fn(base.records.write);
    const runtime = createLocalWorkflowRuntime({ ...base, records: { ...base.records, write },
      observations: { ...base.observations, artifact, entityFrontmatter } });
    await runtime.submit(root, run.runId, { kind: "human-input", input: validInput(source) });
    expect(artifact).toHaveBeenCalledOnce();
    expect(entityFrontmatter).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledOnce();
  });

  it("admits all six closed field forms and stamps an immutable host envelope", async () => {
    process.env.LLMWIKI_ACTOR = "editor-one";
    try {
      const { root, run, source } = await fixture();
      const result = await submitStageOutput(root, run.runId, { kind: "human-input", input: validInput(source) });
      expect(result).toMatchObject({ applied: true, decision: "accepted" });
      expect(result.run.outputs.frame).toMatchObject({ kind: "human-input-ref", schemaId: "newsroom/story-frame-v1", submittedBy: "editor-one" });
      expect(result.run.outputs.frame).toMatchObject({ payload: { format: "brief", notes: [] } });
      expect(result.run.outputs.frame).toMatchObject({ predecessorOutputDigest: canonicalDigest({}) });
    } finally {
      delete process.env.LLMWIKI_ACTOR;
    }
  });

  it("replays the identical admitted payload idempotently and rejects a divergent replay", async () => {
    const { root, run, source } = await fixture();
    const output = { kind: "human-input" as const, input: validInput(source) };
    const first = await submitStageOutput(root, run.runId, output);
    const before = await readRun(root, run.runId);
    const second = await submitStageOutput(root, run.runId, output);
    expect(second.run).toMatchObject({ stateVersion: first.run.stateVersion, events: first.run.events, outputs: first.run.outputs });
    expect(await readRun(root, run.runId)).toEqual(before);
    await expect(submitStageOutput(root, run.runId, { kind: "human-input", input: { ...validInput(source), angle: "Changed" } })).rejects.toThrow(/already/i);
  });

  it.each([
    ["unknown key", (source: string) => ({ ...validInput(source), forged: true })],
    ["nested value", (source: string) => ({ ...validInput(source), angle: { text: "nested" } })],
    ["oversized UTF-8 value", (source: string) => ({ ...validInput(source), angle: "🧪".repeat(21) })],
    ["oversized list", (source: string) => ({ ...validInput(source), notes: ["one", "two", "three", "four"] })],
    ["outside entity subset", (source: string) => ({ ...validInput(source), desk: "desks/politics" })],
    ["unhealthy artifact", () => ({ ...validInput("source/other@sha256:" + "a".repeat(64)) })],
    ["bad lifecycle", (source: string) => ({ ...validInput(source), related: ["desks/closed"] })],
  ])("rejects %s without changing the run", async (_label, mutate) => {
    const { root, run, source } = await fixture();
    const before = await readRun(root, run.runId);
    await expect(submitStageOutput(root, run.runId, { kind: "human-input", input: mutate(source) }))
      .rejects.toBeInstanceOf(HumanInputValidationError);
    expect(await readRun(root, run.runId)).toEqual(before);
  });

  it("rejects a healthy artifact outside the bound source subset", async () => {
    const { root, run, outsideSource } = await fixture();
    const before = await readRun(root, run.runId);
    await expect(submitStageOutput(root, run.runId, { kind: "human-input", input: validInput(outsideSource) }))
      .rejects.toBeInstanceOf(HumanInputValidationError);
    expect(await readRun(root, run.runId)).toEqual(before);
  });

  it("captures caller data before asynchronous validation", async () => {
    const { root, run, source } = await fixture();
    const input = validInput(source);
    const pending = submitStageOutput(root, run.runId, { kind: "human-input", input });
    input.angle = "mutated after call";
    const result = await pending;
    expect(result.run.outputs.frame).toMatchObject({ payload: { angle: "Follow the evidence" } });
  });

  it("parks visibly for human input and advances only after settlement", async () => {
    const { root, run, source } = await fixture();
    expect((await advanceWorkflow(root, run.runId)).outcome).toBe("needs-human-input");
    expect((await workflowStatus(root, run.runId))[0]).toMatchObject({ needsHumanInput: true, humanInputSchemaId: "newsroom/story-frame-v1" });
    await submitStageOutput(root, run.runId, { kind: "human-input", input: validInput(source) });
    expect((await advanceWorkflow(root, run.runId)).outcome).toBe("completed");
  });

  it("surfaces the full input descriptor through generic workflow discovery", async () => {
    const { root } = await fixture();
    expect((await showWorkflow(root, "story")).stages[0].humanInput)
      .toMatchObject({ schemaId: "newsroom/story-frame-v1", fields: { angle: { kind: "string" } } });
  });
});

/**
 * @file test/workflow-store.test.ts
 * @description Behavioural tests for the confined workflow run store.
 *
 * Covers: mint→write→read round-trip, mintRunId slug-safety, absent reads,
 * bad-id reads (no fs touch), corrupt JSON, too-new schema, in-JSON id mismatch,
 * listRuns filtering to slug-safe `.json` stems, and resolveRunId lookup.
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  mintRunId,
  writeRun,
  readRun,
  listRuns,
  resolveRunId,
  WorkflowRunIdError,
} from "../src/workflows/store.js";
import { WORKFLOW_RUN_SCHEMA_VERSION, type WorkflowRun } from "../src/workflows/types.js";
import { isSlugSafe } from "../src/profile/identity.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { validDigest, expectSignedRoundTrip } from "./fixtures/run-integrity.js";

const ctx = useConfinementRoots("wf-store");

function sampleRun(runId: string, workflowId = "build"): WorkflowRun {
  return {
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
    runId,
    workflowId,
    workflowDigest: validDigest("wf"),
    profileDigest: validDigest("pf"),
    knownStageIds: ["draft", "review"],
    status: "pending",
    currentStage: "draft",
    stageLog: [{ stageId: "draft", status: "pending" }],
    inputs: { topic: "x" },
    outputs: {},
    stateVersion: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    events: [
      { type: "workflow-start", at: "2026-01-01T00:00:00.000Z", actorKind: "system", stateVersionBefore: 0, stateVersionAfter: 0 },
    ],
    satisfiedGates: [],
  };
}

/** Directory holding the per-run JSON files, for planting raw fixtures. */
function runsDir(root: string): string {
  return path.join(root, ".llmwiki", "workflows", "runs");
}

/** Plant raw `body` (string or object) at the `<id>.json` run leaf. */
async function plantRunLeaf(root: string, id: string, body: unknown): Promise<void> {
  await mkdir(runsDir(root), { recursive: true });
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  await writeFile(path.join(runsDir(root), `${id}.json`), raw, "utf8");
}

describe("workflow run store round-trip", () => {
  it("mint → write → read returns an equal run with status ok", async () => {
    await expectSignedRoundTrip(ctx.root, sampleRun(mintRunId("build")));
  });
});

describe("mintRunId", () => {
  it("is slug-safe and starts with the workflow id", () => {
    const id = mintRunId("build");
    expect(isSlugSafe(id)).toBe(true);
    expect(id.startsWith("build-")).toBe(true);
  });
});

describe("writeRun bad-id", () => {
  it("throws WorkflowRunIdError for a non-slug-safe runId", async () => {
    const run = sampleRun("../escape");
    await expect(writeRun(ctx.root, run)).rejects.toBeInstanceOf(WorkflowRunIdError);
  });
});

describe("readRun absent and bad-id", () => {
  it("returns absent for a run that does not exist", async () => {
    expect(await readRun(ctx.root, "build-2026-01-01-aaaa")).toEqual({ status: "absent" });
  });

  it("returns unavailable bad-id for a non-slug-safe id and touches nothing", async () => {
    const result = await readRun(ctx.root, "../escape");
    expect(result).toEqual({ status: "unavailable", detail: "bad-id" });
  });
});

describe("readRun fail-closed parsing", () => {
  it("returns unavailable corrupt for non-JSON bytes", async () => {
    const id = "build-2026-01-01-bbbb";
    await plantRunLeaf(ctx.root, id, "{not json");
    expect((await readRun(ctx.root, id)).status).toBe("unavailable");
  });

  it("surfaces a too-new schemaVersion as unavailable (not repaired)", async () => {
    const id = "build-2026-01-01-cccc";
    await plantRunLeaf(ctx.root, id, { ...sampleRun(id), schemaVersion: 2 });
    expect((await readRun(ctx.root, id)).status).toBe("unavailable");
  });

  it("rejects a file whose in-JSON runId differs from the filename stem", async () => {
    const stem = "build-2026-01-01-dddd";
    await plantRunLeaf(ctx.root, stem, sampleRun("build-2026-01-01-eeee"));
    expect(await readRun(ctx.root, stem)).toEqual({ status: "unavailable", detail: "id-mismatch" });
  });

  it("rejects a record whose events array carries a malformed (non-object) element", async () => {
    const id = "build-2026-01-01-ffff";
    await plantRunLeaf(ctx.root, id, { ...sampleRun(id), events: ["not-an-event"] });
    expect((await readRun(ctx.root, id)).status).toBe("unavailable");
  });
});

describe("listRuns and resolveRunId", () => {
  it("lists only slug-safe .json stems, ignoring junk files", async () => {
    await writeRun(ctx.root, sampleRun("build-2026-01-01-1111"));
    await writeRun(ctx.root, sampleRun("build-2026-01-01-2222"));
    await writeFile(path.join(runsDir(ctx.root), "notes.txt"), "junk", "utf8");
    await writeFile(path.join(runsDir(ctx.root), "BAD ID.json"), "{}", "utf8");
    const list = await listRuns(ctx.root);
    expect(list.status).toBe("ok");
    if (list.status === "ok") {
      expect(list.runIds.sort()).toEqual(["build-2026-01-01-1111", "build-2026-01-01-2222"]);
    }
  });

  it("resolveRunId resolves a present id, not-found otherwise", async () => {
    await writeRun(ctx.root, sampleRun("build-2026-01-01-3333"));
    expect(await resolveRunId(ctx.root, "build-2026-01-01-3333")).toEqual({ status: "resolved", runId: "build-2026-01-01-3333" });
    expect(await resolveRunId(ctx.root, "build-2026-01-01-9999")).toEqual({ status: "not-found" });
    expect(await resolveRunId(ctx.root, "../escape")).toEqual({ status: "not-found" });
  });
});

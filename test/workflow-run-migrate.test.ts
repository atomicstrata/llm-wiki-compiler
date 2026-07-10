/**
 * @file test/workflow-run-migrate.test.ts
 * @description BUG 2 regression: the run-record schema gate must fail closed ONLY
 * on a NEWER version, route an OLDER version through `migrateRun`, and never brick
 * a fleet on a version bump.
 *
 * The `!==` gate previously rejected an OLDER version as `schema-too-new`. The
 * gate now fails closed only when `schemaVersion > CURRENT`; an older version is
 * forward-migrated (migrate-on-read) and continues shape validation. The
 * `migrateRun` ladder is unit-tested directly: it upgrades a registered older
 * version and returns `null` for an unmigratable one.
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readRun, writeRun } from "../src/workflows/store.js";
import { migrateRun } from "../src/workflows/run-migrate.js";
import { WORKFLOW_RUN_SCHEMA_VERSION, type WorkflowRun } from "../src/workflows/types.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { validDigest } from "./fixtures/run-integrity.js";

const ctx = useConfinementRoots("wf-migrate");

function sampleRun(runId: string): WorkflowRun {
  return {
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION, runId, workflowId: "build",
    workflowDigest: validDigest("wf"), profileDigest: validDigest("pf"), knownStageIds: ["review"],
    status: "running", currentStage: "review", stageLog: [{ stageId: "review", status: "running" }],
    inputs: {}, outputs: {}, stateVersion: 1, startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    events: [{ type: "workflow-start", at: "2026-01-01T00:00:00.000Z", actorKind: "system", stateVersionBefore: 0, stateVersionAfter: 1 }],
    satisfiedGates: [],
  };
}

/** Plant a run record's raw JSON bytes directly at its leaf. */
async function plantRaw(root: string, runId: string, body: unknown): Promise<void> {
  const dir = path.join(root, ".llmwiki", "workflows", "runs");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${runId}.json`), JSON.stringify(body), "utf8");
}

describe("BUG 2 — run-record schema gate direction + migration", () => {
  it("a NEWER schemaVersion still fails closed as schema-too-new (unchanged)", async () => {
    const runId = "build-2026-01-01-new1";
    await plantRaw(ctx.root, runId, { ...sampleRun(runId), schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION + 1 });
    expect(await readRun(ctx.root, runId)).toEqual({ status: "unavailable", detail: "schema-too-new" });
  });

  it("a run at the CURRENT version reads ok (unchanged)", async () => {
    const runId = "build-2026-01-01-cur1";
    await writeRun(ctx.root, sampleRun(runId));
    expect((await readRun(ctx.root, runId)).status).toBe("ok");
  });

  it("an OLDER-version record is NOT rejected as schema-too-new (the !== bug is gone)", async () => {
    const runId = "build-2026-01-01-old1";
    await plantRaw(ctx.root, runId, { ...sampleRun(runId), schemaVersion: 0 });
    const read = await readRun(ctx.root, runId);
    // v0 has no registered migration step (v1 is the floor), so it fails closed
    // CLEANLY as unmigratable — NOT as the wrong "schema-too-new" reason.
    expect(read).toEqual({ status: "unavailable", detail: "unmigratable" });
  });

  it("a v1 (pre-HMAC, unsigned) record migrates to v2 SHAPE but reads legacy-unsigned", async () => {
    const runId = "build-2026-01-01-v1leg";
    // A genuine v1 record predates the integrity HMAC, so it arrives unsigned. It is
    // shape-migrated to v2 but surfaced as legacy-unsigned (a DISTINCT detail from a
    // tampered v2 `integrity`) — never silently trusted, never silently bricked.
    await plantRaw(ctx.root, runId, { ...sampleRun(runId), schemaVersion: 1 });
    expect(await readRun(ctx.root, runId)).toEqual({ status: "unavailable", detail: "legacy-unsigned" });
  });
});

describe("migrateRun ladder", () => {
  it("returns the upgraded record (schemaVersion stamped to CURRENT) for a current-version no-op", () => {
    const migrated = migrateRun({ schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION }, WORKFLOW_RUN_SCHEMA_VERSION);
    expect(migrated).not.toBeNull();
    expect(migrated?.schemaVersion).toBe(WORKFLOW_RUN_SCHEMA_VERSION);
  });

  it("returns null for a version with no registered migration step", () => {
    expect(migrateRun({ schemaVersion: 0 }, 0)).toBeNull();
  });

  it("upgrades a v1 record to v2 shape, DROPPING any (meaningless) v1 integrity", () => {
    // A v1 record predates the HMAC; migration must NEVER carry a v1 `integrity`
    // forward as if trusted (auto-signing an unsigned record reopens the forgery hole).
    const migrated = migrateRun({ schemaVersion: 1, runId: "x", integrity: "deadbeef" }, 1);
    expect(migrated?.schemaVersion).toBe(WORKFLOW_RUN_SCHEMA_VERSION);
    expect(migrated?.integrity).toBeUndefined();
  });
});

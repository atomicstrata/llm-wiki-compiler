/**
 * @file test/workflow-run-integrity.test.ts
 * @description R3 hardening regressions for the durable run record.
 *
 * Three fixes are exercised here against the `readRun` gate:
 *  - FIX 1 (deep shape): a forged-but-array-shaped record — malformed `stageLog`,
 *    non-grammar `satisfiedGates`, array `outputs`, wrong-typed digests, an unsafe
 *    `stateVersion`, missing timestamps — now reads `unavailable`, not `ok`.
 *  - FIX 3 (version chain): a forged/rewound `stateVersion` or a non-genesis first
 *    event reads `unavailable:"version-chain"`; a valid (incl. parked) run reads ok.
 *  - FIX 4 (HMAC tamper-evidence): a `writeRun` run round-trips ok; a hand-edited,
 *    foreign-key, or unsigned record reads `unavailable:"integrity"`. The
 *    forge-a-completed-run exploit is now BLOCKED.
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile, stat, access } from "node:fs/promises";
import path from "node:path";
import { writeRun, readRun } from "../src/workflows/store.js";
import { loadOrCreateRunKey } from "../src/workflows/integrity.js";
import { WORKFLOW_RUN_SCHEMA_VERSION, type WorkflowRun } from "../src/workflows/types.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { validDigest, signRun, plantSignedRun, runsDir } from "./fixtures/run-integrity.js";

const ctx = useConfinementRoots("wf-integrity");

function sampleRun(runId: string): WorkflowRun {
  const at = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION, runId, workflowId: "build",
    workflowDigest: validDigest("wf"), profileDigest: validDigest("pf"),
    knownStageIds: ["review"], status: "pending", currentStage: "review",
    stageLog: [{ stageId: "review", status: "pending" }], inputs: {}, outputs: {},
    stateVersion: 0, startedAt: at, updatedAt: at,
    events: [{ type: "workflow-start", at, actorKind: "system", stateVersionBefore: 0, stateVersionAfter: 0 }],
    satisfiedGates: [],
  };
}

/** Plant a record with `patch` merged in, SIGNED (so only the patched shape is on trial). */
async function plantPatched(id: string, patch: Record<string, unknown>): Promise<void> {
  await plantSignedRun(ctx.root, { ...sampleRun(id), ...patch } as WorkflowRun);
}

async function detailOf(id: string): Promise<string> {
  const read = await readRun(ctx.root, id);
  return read.status === "unavailable" ? read.detail : read.status;
}

describe("FIX 1 — deep run-record shape validation", () => {
  it("rejects a stageLog entry missing stageId", async () => {
    await plantPatched("build-2026-01-01-sl01", { stageLog: [{ status: "pending" }] });
    expect(await detailOf("build-2026-01-01-sl01")).toBe("schema");
  });

  it("rejects a satisfiedGates list with a non-string / non-grammar entry", async () => {
    await plantPatched("build-2026-01-01-sg01", { satisfiedGates: [42, { evil: true }] });
    expect(await detailOf("build-2026-01-01-sg01")).toBe("schema");
  });

  it("rejects an outputs ARRAY (would silently coerce to {} on adapt)", async () => {
    await plantPatched("build-2026-01-01-out1", { outputs: ["a", "b"] });
    expect(await detailOf("build-2026-01-01-out1")).toBe("schema");
  });

  it("rejects a non-hex workflowDigest", async () => {
    await plantPatched("build-2026-01-01-dg01", { workflowDigest: "abc123" });
    expect(await detailOf("build-2026-01-01-dg01")).toBe("schema");
  });

  it("rejects a stateVersion at Number.MAX_SAFE_INTEGER + 1 (unsafe int)", async () => {
    await plantPatched("build-2026-01-01-sv01", {
      stateVersion: Number.MAX_SAFE_INTEGER + 1,
      events: [{ type: "workflow-start", at: "2026-01-01T00:00:00.000Z", actorKind: "system", stateVersionBefore: 0, stateVersionAfter: Number.MAX_SAFE_INTEGER + 1 }],
    });
    expect(await detailOf("build-2026-01-01-sv01")).toBe("schema");
  });

  it("rejects a non-string startedAt timestamp", async () => {
    await plantPatched("build-2026-01-01-ts01", { startedAt: 123 });
    expect(await detailOf("build-2026-01-01-ts01")).toBe("schema");
  });
});

describe("FIX 3 — event version-chain verification", () => {
  it("rejects a run whose stateVersion does not match the last event's after", async () => {
    await plantPatched("build-2026-01-01-vc01", { stateVersion: 7 });
    expect(await detailOf("build-2026-01-01-vc01")).toBe("version-chain");
  });

  it("rejects a rewound / non-monotone event chain", async () => {
    const at = "2026-01-01T00:00:00.000Z";
    await plantPatched("build-2026-01-01-vc02", {
      stateVersion: 1,
      events: [
        { type: "workflow-start", at, actorKind: "system", stateVersionBefore: 0, stateVersionAfter: 5 },
        { type: "stage-advanced", at, actorKind: "system", stateVersionBefore: 2, stateVersionAfter: 1 },
      ],
    });
    expect(await detailOf("build-2026-01-01-vc02")).toBe("version-chain");
  });

  it("accepts a parked run (writeRun without an appended event) round-trip", async () => {
    const run = sampleRun("build-2026-01-01-vc03");
    await writeRun(ctx.root, run);
    expect((await readRun(ctx.root, "build-2026-01-01-vc03")).status).toBe("ok");
  });
});

describe("FIX 4 — per-record HMAC tamper-evidence", () => {
  it("round-trips a writeRun-written run as ok", async () => {
    const run = sampleRun("build-2026-01-01-hm01");
    await writeRun(ctx.root, run);
    const read = await readRun(ctx.root, "build-2026-01-01-hm01");
    expect(read.status).toBe("ok");
  });

  it("rejects the forge-a-completed-run exploit: status flipped without re-signing", async () => {
    const run = sampleRun("build-2026-01-01-hm02");
    const signed = await signRun(ctx.root, run);
    const forged = { ...signed, status: "completed", satisfiedGates: ["human:reviewed"] };
    await mkdir(runsDir(ctx.root), { recursive: true });
    await writeFile(path.join(runsDir(ctx.root), `${run.runId}.json`), JSON.stringify(forged), "utf8");
    expect(await detailOf("build-2026-01-01-hm02")).toBe("integrity");
  });

  it("rejects a record signed with a DIFFERENT project's key", async () => {
    await writeRun(ctx.root, sampleRun("build-2026-01-01-seed")); // mint this project's own key
    const run = sampleRun("build-2026-01-01-hm03");
    const foreign = await signRun(ctx.outside, run); // signed under a DIFFERENT root's key
    await writeFile(path.join(runsDir(ctx.root), `${run.runId}.json`), JSON.stringify(foreign), "utf8");
    expect(await detailOf("build-2026-01-01-hm03")).toBe("integrity");
  });

  it("rejects a record with no integrity field at all", async () => {
    await plantSignedRun(ctx.root, sampleRun("build-2026-01-01-hm04"), { sign: false });
    expect(await detailOf("build-2026-01-01-hm04")).toBe("integrity");
  });
});

describe("FIX 4 — .runkey confinement", () => {
  it("creates the key 0600, BESIDE runs/ (not under it)", async () => {
    await loadOrCreateRunKey(ctx.root);
    const keyPath = path.join(ctx.root, ".llmwiki", "workflows", ".runkey");
    const st = await stat(keyPath);
    if (process.platform !== "win32") expect(st.mode & 0o777).toBe(0o600);
    // The key must not sit UNDER runs/, so it is never enumerated as a run id.
    await expect(access(path.join(runsDir(ctx.root), ".runkey"))).rejects.toThrow();
  });
});

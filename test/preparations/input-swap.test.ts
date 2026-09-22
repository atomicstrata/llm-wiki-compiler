/**
 * @file test/preparations/input-swap.test.ts
 * @description Adversarial prepared-input capture: the copy-then-recheck must
 * reject a file replaced between plan and materialize, a changed inode/metadata,
 * a changed digest, a symlinked leaf, a FIFO leaf (without hanging), an oversize
 * file, and a source that becomes unreadable before the second recheck read.
 */

import { execFileSync } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { mintPreparationId } from "../../src/preparations/ids.js";
import {
  MAX_PREPARED_INPUT_OBJECT_BYTES, materializeCallerFileInput, planCallerFileInput,
} from "../../src/preparations/inputs.js";
import type {
  EvidenceRetention, MaterializeCallerFileFaultsForTest, PlanCallerFileOptionsV1,
  PreparedInputUnavailableCode,
} from "../../src/preparations/inputs.js";
import { callerSource, writeSourceFile } from "./inputs-fixture.js";

const root = useTempRoot();
const srcRoot = () => `${root.dir}/sources`;
const location = () => ({ workspaceId: "research", preparationId: mintPreparationId() });
const RETENTION: EvidenceRetention = "until-handoff";

async function plannedFor(name: string, bytes: Buffer, opts: PlanCallerFileOptionsV1 = {}) {
  const leaf = await writeSourceFile(srcRoot(), name, bytes);
  return { leaf, planned: await planCallerFileInput(callerSource(srcRoot(), leaf, { retention: RETENTION }), opts) };
}

describe("planCallerFileInput refuses untrusted leaves", () => {
  it("rejects a symlinked leaf as unavailable", async () => {
    await writeSourceFile(srcRoot(), "real.txt", Buffer.from("x"));
    await symlink(`${srcRoot()}/real.txt`, `${srcRoot()}/link.txt`);
    const planned = await planCallerFileInput(callerSource(srcRoot(), `${srcRoot()}/link.txt`));
    expect(planned).toEqual({ status: "unavailable", code: "unavailable" });
  });

  it("rejects a FIFO leaf without blocking", async () => {
    await writeSourceFile(srcRoot(), "keep", Buffer.from("x"));
    execFileSync("mkfifo", ["-m", "600", `${srcRoot()}/pipe`]);
    const planned = await planCallerFileInput(callerSource(srcRoot(), `${srcRoot()}/pipe`));
    expect(planned).toEqual({ status: "unavailable", code: "unavailable" });
  });

  it("rejects an oversize file against the capture cap", async () => {
    expect(MAX_PREPARED_INPUT_OBJECT_BYTES).toBeGreaterThan(4);
    const { planned } = await plannedFor("big.txt", Buffer.from("0123456789"), { maxBytes: 4 });
    expect(planned).toEqual({ status: "unavailable", code: "oversize" });
  });

  it("reports an absent source distinctly", async () => {
    await mkdir(srcRoot(), { recursive: true });
    const expected: PreparedInputUnavailableCode = "absent";
    const planned = await planCallerFileInput(callerSource(srcRoot(), `${srcRoot()}/missing.txt`));
    expect(planned).toEqual({ status: "unavailable", code: expected });
  });
});

describe("materializeCallerFileInput copy-then-recheck", () => {
  it("rejects a file whose content was replaced after planning", async () => {
    const { leaf, planned } = await plannedFor("swap.txt", Buffer.from("original"));
    if (planned.status !== "planned") throw new Error("not planned");
    await writeFile(leaf, Buffer.from("modified")); // same byte length keeps the inode identity
    const done = await materializeCallerFileInput(root.dir, location(), planned.prepared);
    expect(done).toEqual({ status: "unavailable", code: "changed-digest" });
  });

  it("rejects a leaf whose bytes change between copy and the recheck", async () => {
    const { leaf, planned } = await plannedFor("recheck.txt", Buffer.from("stable-1"));
    if (planned.status !== "planned") throw new Error("not planned");
    const faults: MaterializeCallerFileFaultsForTest = {
      beforeRecheck: async () => { await writeFile(leaf, Buffer.from("stable-2")); },
    };
    const done = await materializeCallerFileInput(root.dir, location(), planned.prepared, faults);
    expect(done.status).toBe("unavailable");
    if (done.status !== "unavailable") return;
    expect(["changed-digest", "changed-metadata"]).toContain(done.code);
  });

  it("reports a source removed before the recheck as second-read-unavailable", async () => {
    const { leaf, planned } = await plannedFor("gone.txt", Buffer.from("here-now"));
    if (planned.status !== "planned") throw new Error("not planned");
    const done = await materializeCallerFileInput(root.dir, location(), planned.prepared, {
      beforeRecheck: async () => { await rm(leaf); },
    });
    expect(done).toEqual({ status: "unavailable", code: "second-read-unavailable" });
  });
});

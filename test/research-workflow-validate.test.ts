/**
 * @file test/research-workflow-validate.test.ts
 * @description The five research workflows + their `workflowActions` LOAD and
 * VALIDATE as pure profile config over the landed P5 harness, and the read-only
 * discovery surfaces (`workflow list`, `workflow action list`/`show`) enumerate
 * them — including the per-surface permission CLAMP (an `mcp` request for
 * `trusted-write` is capped to `staged-write`). Proves the "stages are
 * representable by profile config" superset bullet without executing any stage.
 * A final negative case proves the loader fails closed on a malformed action (a
 * `submit` action shaped for a forbidden non-page field). Subprocess-level so it
 * exercises the same seam an operator would.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCLI } from "./fixtures/run-cli.js";
import { installResearchProfile, RESEARCH_PROFILE } from "./fixtures/research-profile.js";
import { PROFILE_FILE } from "../src/utils/constants.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "research-wf-validate-")); await installResearchProfile(root); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** Write a raw profile object as `.llmwiki/profile.json`, bypassing the normal
 * installer — for negative-validation tests that need a deliberately corrupted profile. */
async function writeRawProfile(root: string, profile: unknown): Promise<void> {
  await writeFile(path.join(root, PROFILE_FILE), `${JSON.stringify(profile, null, 2)}\n`, "utf8");
}

describe("research workflows — load + discovery", () => {
  it("lists all five workflow ids", async () => {
    const res = await runCLI(["workflow", "list"], root);
    expect(res.code).toBe(0);
    for (const id of ["literature-review", "research", "experiment-design", "manuscript-writing", "review-response"]) {
      expect(res.stdout).toContain(id);
    }
    expect(res.stdout).not.toMatch(/^manuscript:/m); // the old un-suffixed id is gone
  });
});

describe("research workflow actions — discovery + per-surface clamp", () => {
  it("enumerates the declared actions", async () => {
    const res = await runCLI(["workflow", "action", "list"], root);
    expect(res.code).toBe(0);
    for (const id of ["research.begin", "research.check", "research.step", "literature.file-paper", "review-response.approve"]) {
      expect(res.stdout).toContain(id);
    }
  });

  it("clamps an mcp trusted-write request to staged-write on show", async () => {
    const res = await runCLI(["workflow", "action", "show", "research.begin"], root);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/cli:\s*trusted-write/);
    expect(res.stdout).toMatch(/mcp:\s*staged-write/);
  });

  it("rejects a submit action that declares a non-page (kind) input", async () => {
    // Deep-clone, corrupt one action, write it, and prove the CLI surfaces the error.
    const bad = structuredClone(RESEARCH_PROFILE);
    (bad.workflowActions!["literature.file-paper"].inputSchema as Record<string, unknown>).kind = { type: "string" };
    await writeRawProfile(root, bad);
    const res = await runCLI(["workflow", "action", "list"], root);
    expect(res.code).not.toBe(0);
    expect(res.stdout + res.stderr).toMatch(/submit|page/i);
  });
});

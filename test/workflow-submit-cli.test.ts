/**
 * @file test/workflow-submit-cli.test.ts
 * @description Real-subprocess tests for `workflow submit` over `dist/cli.js`.
 *
 * Scaffolds a `build` workflow whose single stage declares `writes:["experiments"]`
 * and a `trust:high` gate, then drives the real CLI: start → advance parks
 * awaiting-output (and `status` surfaces it) → `submit --kind page` lands an
 * in-scope page live (the file exists on disk) → advance completes the run.
 * Also asserts the fail-closed surfaces: an out-of-scope `--entity-type` exits
 * non-zero (scope error) and writes nothing, a missing `--body-file` exits
 * non-zero, an unknown `--kind` exits non-zero, and a bogus run id exits non-zero.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, writeFile, stat, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { runCLI } from "./fixtures/run-cli.js";
import { installWorkflowProfile, buildWorkflowProfile } from "./fixtures/workflow-profile.js";
import { MAX_WORKFLOW_SUBMIT_FILE_BYTES, MAX_WORKFLOW_INPUT_DEPTH } from "../src/utils/constants.js";

/** Build a JSON object nested exactly `depth` levels deep. */
function nestJson(depth: number): unknown {
  let inner: unknown = 1;
  for (let i = 0; i < depth; i++) inner = { a: inner };
  return inner;
}

let root = "";
let bodyFile = "";

/** Install a single-stage `build` workflow that writes `experiments` under a `trust:high` gate. */
async function installWriteProfile(): Promise<void> {
  await installWorkflowProfile(
    root,
    buildWorkflowProfile([{ id: "run", reads: ["ideas"], writes: ["experiments"], gate: "trust:high" }]),
  );
  bodyFile = path.join(root, "body.md");
  await writeFile(bodyFile, "---\ntitle: alpha\n---\nbody", "utf8");
}

/** Start a run and advance once so it parks awaiting-output on the write stage. */
async function startAndPark(): Promise<string> {
  const start = await runCLI(["workflow", "start", "build"], root);
  const runId = (start.stdout.match(/build-[\w-]+/) ?? [""])[0];
  expect((await runCLI(["workflow", "advance", runId], root)).code).toBe(0);
  return runId;
}

/** The absolute path the planner derives for an `experiments` page. */
function experimentPath(slug: string): string {
  return path.join(root, "wiki", "experiments", `${slug}.md`);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "workflow-submit-cli-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("workflow submit happy path", () => {
  it("surfaces awaiting-output, submits a page, applies it live, then completes", async () => {
    await installWriteProfile();
    const runId = await startAndPark();

    const status = await runCLI(["workflow", "status", runId], root);
    expect(status.stdout).toMatch(/awaiting-output/i);

    // A `trust:`-gated apply requires the operator's out-of-band trusted-write
    // grant (C3); pass it for the fixture project (profileId "research") so the
    // page lands live and the run can complete.
    const grant = { LLMWIKI_TRUSTED_WRITE: "research" };
    const submit = await runCLI(
      ["workflow", "submit", runId, "--kind", "page", "--entity-type", "experiments", "--slug", "alpha", "--body-file", bodyFile],
      root,
      grant,
    );
    expect(submit.code).toBe(0);
    expect(submit.stdout).toMatch(/applied/i);
    expect((await stat(experimentPath("alpha"))).isFile()).toBe(true);

    expect((await runCLI(["workflow", "advance", runId], root)).stdout).toMatch(/completed/);
  });
});

describe("workflow submit fail-closed surfaces", () => {
  it("exits non-zero on an out-of-scope --entity-type and writes nothing", async () => {
    await installWriteProfile();
    const runId = await startAndPark();
    const bad = await runCLI(
      ["workflow", "submit", runId, "--kind", "page", "--entity-type", "ideas", "--slug", "x", "--body-file", bodyFile],
      root,
    );
    expect(bad.code).not.toBe(0);
    await expect(stat(experimentPath("x"))).rejects.toThrow();
  });

  it("exits non-zero on a missing --body-file", async () => {
    await installWriteProfile();
    const runId = await startAndPark();
    const bad = await runCLI(
      ["workflow", "submit", runId, "--kind", "page", "--entity-type", "experiments", "--slug", "x", "--body-file", path.join(root, "nope.md")],
      root,
    );
    expect(bad.code).not.toBe(0);
  });

  it("exits non-zero on an unknown --kind", async () => {
    await installWriteProfile();
    const runId = await startAndPark();
    const bad = await runCLI(["workflow", "submit", runId, "--kind", "bogus"], root);
    expect(bad.code).not.toBe(0);
  });

  it("exits non-zero for a bogus run id", async () => {
    await installWriteProfile();
    const bad = await runCLI(
      ["workflow", "submit", "build-2026-01-01-9999", "--kind", "page", "--entity-type", "experiments", "--slug", "x", "--body-file", bodyFile],
      root,
    );
    expect(bad.code).not.toBe(0);
  });

  it("exits non-zero on a --body-file over the file-size cap (before slurp)", async () => {
    await installWriteProfile();
    const runId = await startAndPark();
    const huge = path.join(root, "huge.md");
    await writeFile(huge, "x".repeat(MAX_WORKFLOW_SUBMIT_FILE_BYTES + 1), "utf8");
    const bad = await runCLI(
      ["workflow", "submit", runId, "--kind", "page", "--entity-type", "experiments", "--slug", "x", "--body-file", huge],
      root,
    );
    expect(bad.code).not.toBe(0);
  });

  it("exits non-zero on a deeply-nested --output-file JSON (depth-bounded before use)", async () => {
    await installWriteProfile();
    const runId = await startAndPark();
    const deep = path.join(root, "deep.json");
    await writeFile(deep, JSON.stringify(nestJson(MAX_WORKFLOW_INPUT_DEPTH + 3)), "utf8");
    const bad = await runCLI(["workflow", "submit", runId, "--kind", "relation", "--output-file", deep], root);
    expect(bad.code).not.toBe(0);
  });

  // A planted FIFO at --body-file would HANG a naive check-then-open read forever
  // (a local DoS); the handle-bound reader opens O_NONBLOCK + requires a regular file,
  // so it exits promptly. The test timeout would FAIL (not hang) on a regression.
  it("exits non-zero on a FIFO --body-file without hanging (O_NONBLOCK + regular-file gate)", async () => {
    await installWriteProfile();
    const runId = await startAndPark();
    const fifo = path.join(root, "pipe.md");
    execFileSync("mkfifo", [fifo]);
    const bad = await runCLI(
      ["workflow", "submit", runId, "--kind", "page", "--entity-type", "experiments", "--slug", "x", "--body-file", fifo],
      root,
    );
    expect(bad.code).not.toBe(0);
  }, 15000);

  it("exits non-zero on a symlinked --body-file (O_NOFOLLOW rejects the leaf)", async () => {
    await installWriteProfile();
    const runId = await startAndPark();
    const target = path.join(root, "real-body.md");
    await writeFile(target, "---\ntitle: alpha\n---\nbody", "utf8");
    const link = path.join(root, "link-body.md");
    await symlink(target, link);
    const bad = await runCLI(
      ["workflow", "submit", runId, "--kind", "page", "--entity-type", "experiments", "--slug", "x", "--body-file", link],
      root,
    );
    expect(bad.code).not.toBe(0);
  });
});

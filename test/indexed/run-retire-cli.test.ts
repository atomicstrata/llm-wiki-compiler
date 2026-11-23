/**
 * @file test/indexed/run-retire-cli.test.ts
 * @description `llmwiki catalog runs`: unusable plan files, conflicting or
 * invalid options and an inactive project are refused with a typed JSON
 * envelope (exit 2) before anything reads the stores; on a real project
 * (each command in its own child process, as an operator would run it) the
 * preview saves a create-only plan, the retirement needs `--readers-offline`,
 * applies it (exit 0) and refuses it again as stale; the SDK facade's preview
 * agrees with the CLI's.
 */

import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { catalogRunsCommand } from "../../src/commands/catalog-maintenance.js";
import type { RunRetirePreviewV1 } from "../../src/indexed/run-retire.js";
import { jsonCommand } from "../catalog/cli-helpers.js";
import { CASE_TIMEOUT_MS, copyOf, FINISHED_RUNS, ok, tempRoot, useRunsBase } from "./run-retire-helpers.js";

/** One CLI run's exit code and envelope. */
interface CliRun { readonly exit: number; readonly envelope: { readonly ok: boolean; readonly refusal?: { readonly code: string }; readonly preview?: RunRetirePreviewV1; readonly retired?: { readonly retired: unknown[] } } }

const base = useRunsBase(FINISHED_RUNS, "last");

describe("refusals before any read", () => {
  let dir: string;
  beforeEach(async () => { dir = await tempRoot("llmwiki-retire-cli-"); vi.spyOn(process, "cwd").mockReturnValue(dir); });
  afterEach(() => { vi.restoreAllMocks(); });

  /** `catalog runs --json` with `options` in the mocked directory. */
  const runs = (options: Parameters<typeof catalogRunsCommand>[0]) => jsonCommand<CliRun["envelope"]>(() => catalogRunsCommand({ ...options, json: true }));

  it("refuses unusable plan files, conflicting options and an invalid --keep", async () => {
    await writeFile(path.join(dir, "text.json"), "not a plan");
    const cases = [{ retire: path.join(dir, "text.json") }, { retire: path.join(dir, "absent.json") }, { retire: "a.json", out: "b.json" }, { retire: "a.json", keep: "3" }, { keep: "many" }];
    for (const options of cases) {
      const { code, envelope } = await runs(options);
      expect([options, code, envelope.refusal?.code]).toEqual([options, 2, "indexed_runs_plan_invalid"]);
    }
  });

  it("refuses on a project that is not local-indexed", async () => {
    const { code, envelope } = await runs({});
    expect([code, envelope.refusal?.code]).toEqual([2, "catalog_not_active"]);
  });
});

describe("a real project, one process per command", () => {
  it("previews to a create-only plan, requires --readers-offline, retires, then refuses the plan as stale", async () => {
    const project = await copyOf(base());
    const plan = path.join(project.root, "runs-plan.json");
    const previewed = await ok<CliRun>("cli", project.root, "--keep", "0", "--out", plan);
    expect([previewed.exit, previewed.envelope.preview?.retirableRuns]).toEqual([0, 2]);
    expect((await stat(plan)).mode & 0o777).toBe(0o600);
    const unconfirmed = await ok<CliRun>("cli", project.root, "--retire", plan);
    expect([unconfirmed.exit, unconfirmed.envelope.refusal?.code]).toEqual([2, "indexed_runs_offline_unconfirmed"]);
    const retired = await ok<CliRun>("cli", project.root, "--retire", plan, "--readers-offline");
    expect([retired.exit, retired.envelope.retired?.retired.length]).toEqual([0, 2]);
    const again = await ok<CliRun>("cli", project.root, "--retire", plan, "--readers-offline");
    expect([again.exit, again.envelope.refusal?.code]).toEqual([2, "indexed_runs_plan_stale"]);
  }, CASE_TIMEOUT_MS);

  it("the SDK facade's preview classifies every run as the CLI does", async () => {
    const project = await copyOf(base());
    const cli = await ok<CliRun>("cli", project.root, "--keep", "0");
    const sdk = await ok<RunRetirePreviewV1>("sdk-preview", project.root, "0");
    expect(sdk.runs).toEqual(cli.envelope.preview?.runs);
    expect({ ...sdk.plan, createdAt: "" }).toEqual({ ...cli.envelope.preview!.plan, createdAt: "" });
  }, CASE_TIMEOUT_MS);
});

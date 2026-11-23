/**
 * @file test/scale/cli.test.ts
 * @description The real source CLI entry (`src/cli.ts`, run by vite-node with
 * the repository's resolver, in a temporary project) for `init`, `scale` and
 * quickstart's expected-scale flags: help text, versioned JSON envelopes and
 * exit codes (0 ready, 3 blocked, 2 refused with nothing changed), an
 * unavailable estimate recorded and blocking, compile refusing a blocked
 * project before its provider check, and quickstart stopping before any
 * ingest through its own failure envelope. No provider is configured or
 * called. Installed-package behaviour is verified separately at the gates.
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { MISSING_BACKENDS_V2 } from "../../src/scale/contracts-v2.js";
import { runSourceCli } from "./source-cli.js";

const CLI_TIMEOUT_MS = 60_000;

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "llmwiki-scale-cli-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

/** Run the source CLI with `args` in the temporary project. */
function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runSourceCli(cwd, args, CLI_TIMEOUT_MS);
}

/** Parse a JSON stdout envelope. */
const json = (stdout: string): Record<string, any> => JSON.parse(stdout) as Record<string, any>;

describe("the CLI surface", () => {
  it("documents init, scale set and quickstart's expected-scale flags in help", async () => {
    const [init, set, quickstart] = [await cli("init", "--help"), await cli("scale", "set", "--help"), await cli("quickstart", "--help")];
    for (const flag of ["--expected-size", "--expected-documents", "--json"]) expect(init.stdout).toContain(flag);
    for (const flag of ["--size", "--documents", "--no-prepare", "--expect-revision"]) expect(set.stdout).toContain(flag);
    for (const flag of ["--expected-size", "--expected-documents"]) expect(quickstart.stdout).toContain(flag);
  }, 4 * CLI_TIMEOUT_MS);

  it("creates about 100 documents ready, records an unavailable estimate as blocked, and refuses invalid input unchanged", async () => {
    const init = await cli("init", "--expected-documents", "100", "--json");
    expect([init.code, json(init.stdout).readiness, await readdir(path.join(cwd, ".llmwiki"))]).toEqual([0, "ready", ["scale.json"]]);
    const huge = await cli("scale", "set", "--documents", "5000000", "--json");
    // Planned under the version 2 policy: beyond local-indexed, the two backends it still lacks.
    expect([huge.code, json(huge.stdout).readiness, json(huge.stdout).record.pending.missing]).toEqual([3, "unavailable", [...MISSING_BACKENDS_V2]]);
    const prepare = await cli("scale", "prepare", "--json");
    expect([prepare.code, json(prepare.stdout).readiness]).toEqual([3, "unavailable"]);
    const invalid = await cli("scale", "set", "--size", "abc", "--json");
    expect([invalid.code, json(invalid.stdout).refusal.code]).toEqual([2, "scale_invalid_request"]);
    expect(json((await cli("scale", "status", "--json")).stdout).record.revision).toBe(2);
  }, 6 * CLI_TIMEOUT_MS);
});

describe("dependent commands on a blocked project", () => {
  it("refuses compile before its provider check during a deferred transition", async () => {
    const set = await cli("scale", "set", "--documents", "2000", "--no-prepare", "--json");
    expect([set.code, json(set.stdout).readiness]).toEqual([3, "preparing"]);
    const compile = await cli("compile");
    expect(compile.code).toBe(1);
    expect(compile.stderr).toContain("scale-transition-pending");
  }, 3 * CLI_TIMEOUT_MS);

  it("stops quickstart before any ingest through its failure envelope, creating nothing for invalid input", async () => {
    await writeFile(path.join(cwd, "source.md"), "# Source\n\nA witness paragraph for quickstart.\n");
    const invalid = await cli("quickstart", "source.md", "--json", "--expected-documents", "zero");
    expect([invalid.code, json(invalid.stdout).ingest.error.code]).toEqual([1, "scale_invalid_request"]);
    expect(await readdir(cwd)).toEqual(["source.md"]);
    const huge = await cli("quickstart", "source.md", "--json", "--expected-size", "2TB");
    const envelope = json(huge.stdout);
    expect([huge.code, Object.keys(envelope), envelope.ingest.error.code, envelope.next.command])
      .toEqual([1, ["version", "source", "ingest", "compile", "viewer", "next"], "scale-backend-unavailable", "llmwiki scale status"]);
    expect(await readdir(path.join(cwd, "sources"))).toEqual([]);
  }, 3 * CLI_TIMEOUT_MS);
});

describe("quickstart with a small estimate", () => {
  it("records about 100 documents as ready and goes on to ingest, with no provider configured", async () => {
    await writeFile(path.join(cwd, "source.md"), "# Source\n\nA witness paragraph for quickstart, long enough to ingest as a source.\n");
    const run = await cli("quickstart", "source.md", "--json", "--expected-documents", "100");
    const envelope = json(run.stdout);
    expect([envelope.ingest.ok, Object.keys(envelope)]).toEqual([true, ["version", "source", "ingest", "compile", "viewer", "next"]]);
    expect(await readdir(path.join(cwd, "sources"))).toHaveLength(1);
    expect(json((await cli("scale", "status", "--json")).stdout)).toMatchObject({ readiness: "ready", record: { active: { architecture: "local-standard" } } });
  }, 3 * CLI_TIMEOUT_MS);
});

/**
 * CLI-level integration tests for the `llmwiki rules` subcommand family (rule pipeline).
 *
 * Spawns real subprocesses via the shared run-cli fixture so the full CLI
 * surface (Commander routing, exit codes, stdout/stderr) is exercised without
 * mocking internal modules. Candidate JSON is written manually so list /
 * approve / reject / export need no LLM call; `rules extract` is tested only
 * for its credential-failure path (a real extraction would need an API key).
 */

import { describe, it, expect } from "vitest";
import path from "path";
import { mkdir, rm, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { runCLI, expectCLIExit, expectCLIFailure } from "./fixtures/run-cli.js";
import type { RuleCandidate } from "../src/utils/rule-types.js";

/** Create a disposable temp workspace with a sources/ sub-folder. */
async function makeWorkspace(suffix: string): Promise<string> {
  const cwd = path.join(tmpdir(), `llmwiki-rules-${suffix}-${Date.now()}`);
  await mkdir(path.join(cwd, "sources"), { recursive: true });
  return cwd;
}

/** A minimal, import-valid approved candidate for export/list fixtures. */
function makeCandidate(): RuleCandidate {
  return {
    id: "rulecand.process.require-tests-abcd1234",
    proposed: {
      id: "rule.process.require-tests-abcd1234",
      category: "process",
      title: "Require tests",
      description: "PRs need tests.",
      when: "a PR is opened",
      then: "warn",
      version: 1,
    },
    evidence: [{ kind: "file", path: "guide.md", lineStart: 1, lineEnd: 2 }],
    provenance: { source: "llm-wiki-compiler", modelId: "m", modelVersion: "v1" },
    confidence: "high",
    status: "approved",
    createdAt: "2026-05-31T00:00:00.000Z",
  };
}

/** Write a candidate JSON into the pending rule-candidate directory. */
async function writeCandidate(cwd: string, candidate: RuleCandidate): Promise<void> {
  const dir = path.join(cwd, ".llmwiki", "rule-candidates");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${candidate.id}.json`), JSON.stringify(candidate, null, 2), "utf-8");
}

describe("rules CLI integration", () => {
  it("rules list on a fresh project exits 0 and reports no pending candidates", async () => {
    const cwd = await makeWorkspace("list-empty");
    try {
      const result = await runCLI(["rules", "list"], cwd);
      expectCLIExit(result, 0);
      expect(result.stdout.toLowerCase()).toContain("no pending");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it("rules approve with a missing id exits non-zero with a not-found error", async () => {
    const cwd = await makeWorkspace("approve-missing");
    try {
      const result = await runCLI(["rules", "approve", "rulecand.x.does-not-exist"], cwd);
      expectCLIFailure(result);
      expect(`${result.stdout}${result.stderr}`.toLowerCase()).toContain("not found");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it("rules reject with a missing id exits non-zero", async () => {
    const cwd = await makeWorkspace("reject-missing");
    try {
      const result = await runCLI(["rules", "reject", "rulecand.x.does-not-exist"], cwd);
      expectCLIFailure(result);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it("rules export with an invalid --scope exits non-zero with a guidance message", async () => {
    const cwd = await makeWorkspace("export-bad-scope");
    try {
      const result = await runCLI(["rules", "export", "--scope", "bogus"], cwd);
      expectCLIFailure(result);
      expect(`${result.stdout}${result.stderr}`).toContain("scope");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it("rules export writes the candidate array to the default output path", async () => {
    const cwd = await makeWorkspace("export-writes");
    try {
      await writeCandidate(cwd, makeCandidate());
      const result = await runCLI(["rules", "export", "--scope", "approved"], cwd);
      expectCLIExit(result, 0);
      const written = await readFile(path.join(cwd, "dist/exports/rule-candidates.json"), "utf-8");
      const parsed = JSON.parse(written) as RuleCandidate[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0]!.id).toBe("rulecand.process.require-tests-abcd1234");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it("rules extract fails with a credential error when no API key is set", async () => {
    const cwd = await makeWorkspace("extract-no-key");
    try {
      await writeFile(path.join(cwd, "sources", "guide.md"), "Always run tests.\nNo exceptions.\n", "utf-8");
      const result = await runCLI(["rules", "extract"], cwd, {
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      });
      expectCLIFailure(result);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});

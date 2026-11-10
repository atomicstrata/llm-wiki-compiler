/**
 * @file test/lint-fix-propose.test.ts
 * @description AS-1R "check fix-proposal": `lint --fix-propose <n>` turns the
 * nth deterministic lint fix into a reviewable candidate instead of applying it.
 *
 * The three clauses the spec gates, on real files: the proposal is durable and
 * writes NOTHING to wiki/ until `review approve` lands the fixed link; and — the
 * stale-state guard — a target page edited SINCE the proposal is REFUSED at
 * approval, never clobbered by the stale fix. An out-of-range index stages
 * nothing. (`--fix-preview` writing nothing is covered by lint-fix-preview-cli.)
 *
 * The last case runs the REAL binary: `lint --fix-propose 1` with both report
 * flags beside it, so the root command's own dispatch is exercised, not only
 * the writer it calls.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { useCommandProject } from "./fixtures/command-project.js";
import { expectCLIExit, runCLI } from "./fixtures/run-cli.js";
import { lintFixProposeCommand } from "../src/commands/lint-fix-propose.js";
import reviewApproveCommand from "../src/commands/review-approve.js";
import { listCandidates } from "../src/compiler/candidates.js";

let root = "";
const project = useCommandProject("fix-propose-");
const linker = (): string => path.join(root, "wiki", "concepts", "linker.md");

beforeEach(async () => {
  root = project.root;
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  // The page carrying the title, under a filename that differs from its slug —
  // the deterministically fixable shape (retarget the link at the real slug).
  await writeFile(path.join(root, "wiki", "concepts", "sdpa.md"),
    '---\ntitle: "Scaled Dot-Product Attention"\n---\nBody.\n');
  await writeFile(linker(), '---\ntitle: "Linker"\n---\nUses [[Scaled Dot-Product Attention]].\n');
});

describe("lint --fix-propose stages a reviewable fix, applied to land it; a changed target refuses", () => {
  it("proposes a durable candidate and writes nothing until review approve lands the fix", async () => {
    const before = await readFile(linker(), "utf8");
    expect(await lintFixProposeCommand(1)).toBe(0);
    const [candidate] = await listCandidates(root);
    expect(candidate, "no candidate staged").toBeTruthy();
    expect(await readFile(linker(), "utf8"), "propose wrote to wiki/").toBe(before);
    await reviewApproveCommand(candidate!.id);
    expect(await readFile(linker(), "utf8")).toContain("[[sdpa|Scaled Dot-Product Attention]]");
    expect((await listCandidates(root)).length, "candidate not cleared after approval").toBe(0);
  });

  it("REFUSES to approve when the target page changed since the proposal — no clobber", async () => {
    expect(await lintFixProposeCommand(1)).toBe(0);
    const [candidate] = await listCandidates(root);
    const edited = '---\ntitle: "Linker"\n---\nRewritten by hand since the proposal.\n';
    await writeFile(linker(), edited); // the target changes after the fix was proposed
    await reviewApproveCommand(candidate!.id);
    expect(process.exitCode, "a stale fix was approved").toBe(1);
    expect((await listCandidates(root)).length, "candidate cleared despite refusal").toBe(1);
    expect(await readFile(linker(), "utf8"), "the stale fix clobbered the edit").toBe(edited);
  });

  it("REFUSES a candidate whose stale-target hash is malformed — fails CLOSED, never open", async () => {
    // The target is never edited: only the guard is corrupted. A dropped guard
    // would let this approve (fail open); a poisoned guard must refuse.
    expect(await lintFixProposeCommand(1)).toBe(0);
    const [candidate] = await listCandidates(root);
    const dir = path.join(root, ".llmwiki", "candidates");
    const file = path.join(dir, (await readdir(dir)).find((f) => f.endsWith(".json"))!);
    const stored = JSON.parse(await readFile(file, "utf8"));
    stored.expectedTargetHash = "not-a-valid-sha256"; // a damaged / hand-edited guard
    await writeFile(file, JSON.stringify(stored));
    const before = await readFile(linker(), "utf8");
    await reviewApproveCommand(candidate!.id);
    expect(process.exitCode, "a corrupted-guard candidate was approved").toBe(1);
    expect((await listCandidates(root)).length, "candidate cleared despite refusal").toBe(1);
    expect(await readFile(linker(), "utf8"), "clobbered despite a corrupt guard").toBe(before);
  });

  it("rejects an out-of-range finding index without staging anything", async () => {
    expect(await lintFixProposeCommand(99)).toBe(1);
    expect((await listCandidates(root)).length).toBe(0);
  });

  it("through the real binary: fix-propose wins over both report flags, announces the schema once, stages the fix and leaves wiki/ alone", async () => {
    const before = await readFile(linker(), "utf8");
    const result = await runCLI(["lint", "--fix-propose", "1", "--fix-preview", "--tiered"], root);
    expectCLIExit(result, 0);
    const lines = result.stdout.split("\n");
    const at = (text: string): number[] => lines.flatMap((line, index) => (line.includes(text) ? [index] : []));
    const [candidate] = await listCandidates(root);
    expect(candidate, "the binary staged no candidate").toBeTruthy();
    // Header once, then the schema line once, then the proposal: nothing else reports.
    expect([at("Linting wiki").length, at("Schema: defaults (no schema file)").length, at("Proposed fix for").length]).toEqual([1, 1, 1]);
    expect(at("Linting wiki")[0]).toBeLessThan(at("Schema: ")[0]!);
    expect(at("Schema: ")[0]).toBeLessThan(at("Proposed fix for")[0]!);
    expect(lines[at("Proposed fix for")[0]!]).toContain(`llmwiki review approve ${candidate!.id}`);
    // Neither report path ran: no preview footer, no tier heading, no flat summary, no lint cache.
    expect([at("Nothing was written.").length, at("deterministic").length, at("error(s)").length]).toEqual([0, 0, 0]);
    await expect(readFile(path.join(root, ".llmwiki", "last-lint.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await listCandidates(root)).length).toBe(1);
    expect(candidate!.body).toContain("[[sdpa|Scaled Dot-Product Attention]]");
    expect(await readFile(linker(), "utf8"), "the binary wrote to wiki/").toBe(before);
  }, 30_000);
});

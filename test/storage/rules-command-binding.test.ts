/**
 * @file test/storage/rules-command-binding.test.ts
 * @description The `rules` subcommands as ONE body each over their project steps
 * (`rules…CommandWith`), with no project directory: the no-sources refusal, the
 * lock refusals and their exit code, the not-found precheck BEFORE the lock, a
 * candidate removed under the lock, reject as status-then-archive, and the export
 * scope resolved before any read. Each root form is shown reaching its incumbents
 * with the working directory first, the incumbents stubbed.
 *
 * NOT SHOWN HERE: extraction, the candidate store and the export JSON
 * themselves; `rule-extraction-binding`, the rule-candidate suites and
 * `rules-*.test.ts` show those.
 */

import path from "node:path";
import { afterEach, describe, expect, it, vi } from "bun:test";
import {
  rulesApproveCommand, rulesApproveCommandWith, rulesExportCommand, rulesExportCommandWith, rulesExtractCommand,
  rulesExtractCommandWith, rulesListCommandWith, rulesRejectCommandWith, type RulesCommandSteps,
} from "../../src/commands/rules.js";
import * as ruleCandidates from "../../src/compiler/rule-candidates.js";
import * as ruleExtractor from "../../src/compiler/rule-extractor.js";
import * as exportJson from "../../src/export/rule-candidates-json.js";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import * as diskLeaves from "../../src/storage/disk-guarded-leaves.js";
import * as diskLocations from "../../src/storage/disk-locations.js";
import * as lock from "../../src/utils/lock.js";
import * as output from "../../src/utils/output.js";
import type { RuleCandidate } from "../../src/utils/rule-types.js";
import { captureStatusLines } from "./project-tree.js";

const CANDIDATE = { id: "rule-a", status: "proposed", confidence: "high", proposed: { title: "Rule A" } } as unknown as RuleCandidate;
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

/** Every status line and every step, in one order. */
function transcript(): string[] {
  const log: string[] = [];
  captureStatusLines(log);
  vi.spyOn(output, "header").mockImplementation(() => {});
  return log;
}

/** Scripted rules steps logging into `log`. */
function stepsOf(log: string[], answers: { sources?: boolean; locked?: boolean; found?: boolean; updated?: boolean } = {}): RulesCommandSteps {
  return {
    sourcesPresent: () => { log.push("sources?"); return answers.sources ?? true; },
    acquireLock: async () => { log.push("lock"); return answers.locked ?? true; },
    releaseLock: async () => { log.push("release"); },
    extract: async () => { log.push("extract"); return { processedSources: ["s.md"], candidates: [CANDIDATE], notes: [] }; },
    collect: async (scope) => { log.push(`collect ${scope}`); return [CANDIDATE]; },
    readCandidate: async (fileId) => { log.push(`read ${fileId}`); return answers.found === false ? null : CANDIDATE; },
    setStatus: async (fileId, status) => { log.push(`set ${fileId} ${status}`); return answers.updated === false ? null : { ...CANDIDATE, status }; },
    archive: async (fileId) => { log.push(`archive ${fileId}`); return true; },
    writeExport: async (text) => { log.push(`export ${JSON.parse(text).length ?? "?"}`); return "/p/dist/exports/rule-candidates.json"; },
  };
}
const steps = (log: string[]) => log.filter((line) => !/^[^ ]+ /u.test(line) || /^(set|read|collect|export|archive) /u.test(line));

describe("rules subcommands over their steps", () => {
  it("U1 extract refuses with no sources and without the lock sets exit 1; otherwise extracts under the lock", async () => {
    const log = transcript();
    await rulesExtractCommandWith(stepsOf(log, { sources: false }));
    expect([steps(log), process.exitCode]).toEqual([["sources?"], undefined]);
    log.length = 0;
    await rulesExtractCommandWith(stepsOf(log, { locked: false }));
    expect([steps(log), process.exitCode]).toEqual([["sources?", "lock"], 1]);
    process.exitCode = undefined;
    log.length = 0;
    await rulesExtractCommandWith(stepsOf(log));
    expect(steps(log)).toEqual(["sources?", "lock", "extract", "release"]);
  });

  it("U2 approve and reject check the candidate BEFORE the lock; reject sets the status THEN archives", async () => {
    const log = transcript();
    await rulesApproveCommandWith(stepsOf(log, { found: false }), "rule-a");
    expect([steps(log), process.exitCode]).toEqual([["read rule-a"], 1]);
    process.exitCode = undefined;
    log.length = 0;
    await rulesRejectCommandWith(stepsOf(log), "rule-a");
    expect(steps(log)).toEqual(["read rule-a", "lock", "set rule-a rejected", "archive rule-a", "release"]);
  });

  it("U3 a candidate removed under the lock is reported with exit 1 and nothing archived; a held lock refuses", async () => {
    const log = transcript();
    await rulesRejectCommandWith(stepsOf(log, { updated: false }), "rule-a");
    expect([steps(log), process.exitCode]).toEqual([["read rule-a", "lock", "set rule-a rejected", "release"], 1]);
    process.exitCode = undefined;
    log.length = 0;
    await rulesApproveCommandWith(stepsOf(log, { locked: false }), "rule-a");
    expect([steps(log), process.exitCode]).toEqual([["read rule-a", "lock"], 1]);
  });

  it("U4 list reads proposed; export resolves the scope before any read and reports where it wrote", async () => {
    const log = transcript();
    await rulesListCommandWith(stepsOf(log));
    expect(steps(log)).toEqual(["collect proposed"]);
    log.length = 0;
    await expect(rulesExportCommandWith(stepsOf(log), { scope: "nope" })).rejects.toThrow('Unknown --scope value "nope"');
    expect(steps(log)).toEqual([]);
    await rulesExportCommandWith(stepsOf(log));
    expect(log).toEqual(["collect approved", "export 1", "+ Exported 1 rule candidate(s) → /p/dist/exports/rule-candidates.json"]);
  });
});

describe("the root forms reach their incumbents", () => {
  it("Z1 extract, approve and export reach each incumbent with the working directory first", async () => {
    transcript();
    vi.spyOn(process, "cwd").mockReturnValue("/project");
    const exists = vi.spyOn(diskLocations, "locationExistsSync").mockReturnValue(true);
    const acquire = vi.spyOn(lockGate, "acquireMutationLock").mockResolvedValue(true);
    const release = vi.spyOn(lock, "releaseLock").mockResolvedValue(undefined);
    const extract = vi.spyOn(ruleExtractor, "extractRuleCandidates").mockResolvedValue({ processedSources: [], candidates: [], notes: [] });
    await rulesExtractCommand();
    const read = vi.spyOn(ruleCandidates, "readRuleCandidate").mockResolvedValue(CANDIDATE);
    const set = vi.spyOn(ruleCandidates, "setRuleCandidateStatus").mockResolvedValue(CANDIDATE);
    await rulesApproveCommand("rule-a");
    const collect = vi.spyOn(exportJson, "collectRuleCandidatesForExport").mockResolvedValue([]);
    const write = vi.spyOn(diskLeaves, "writeLeafAtomicUnconfined").mockResolvedValue(undefined as never);
    await rulesExportCommand({ scope: "all" });
    expect([exists.mock.calls, acquire.mock.calls, release.mock.calls, extract.mock.calls]).toEqual([
      [[path.join("/project", "sources")]], [["/project", "ordinary"], ["/project", "ordinary"]], [["/project"], ["/project"]], [["/project"]],
    ]);
    expect([read.mock.calls, set.mock.calls, collect.mock.calls, write.mock.calls.map((call) => call[0])]).toEqual([
      [["/project", "rule-a"]], [["/project", "rule-a", "approved"]], [["/project", "all"]], [path.join("/project", "dist/exports/rule-candidates.json")],
    ]);
  });
});

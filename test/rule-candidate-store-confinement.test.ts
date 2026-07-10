/**
 * @file test/rule-candidate-store-confinement.test.ts
 * @description Fail-closed coverage for RULE-candidate-store directory
 * confinement (Phase-3 hardening), mirroring
 * `test/candidate-store-confinement.test.ts` for the sibling concept store.
 *
 * Before this guard, `ruleCandidatePath`/`ruleArchivePath` did a bare
 * `path.join(root, RULE_CANDIDATES_DIR, …)` with NO realpath confinement, then
 * wrote via `atomicWrite` and `readdir`-ed the directory. So a symlinked
 * `.llmwiki/rule-candidates -> /tmp/outside` redirected every
 * write/read/list/archive OUTSIDE the project root — the identical
 * containing-directory escape already closed for the concept store.
 *
 * The rule store now routes every path through the SAME shared confinement
 * helpers (`candidate-store-paths.ts`): a symlinked rule-candidates dir refuses
 * every operation and leaves the out-of-tree dir untouched, while a NORMAL dir
 * still round-trips a candidate identically.
 */

import { describe, it, expect } from "vitest";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildRuleCandidate,
  buildRuleSlug,
  writeRuleCandidate,
  readRuleCandidate,
  listRuleCandidates,
  archiveRuleCandidate,
} from "../src/compiler/rule-candidates.js";
import { candidateFileId } from "../src/utils/candidate-store.js";
import { UnsafeCandidateDirError } from "../src/compiler/candidate-store-paths.js";
import { LLMWIKI_DIR } from "../src/utils/constants.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import type { RuleCandidate } from "../src/utils/rule-types.js";

const ctx = useConfinementRoots("rule-cand");

const FIXED_NOW = "2026-05-31T00:00:00.000Z";

/** A valid RuleCandidate for `title` in the `process` category. */
function candidateFor(title: string): RuleCandidate {
  const slug = buildRuleSlug(title, `${title}|when|then`);
  return buildRuleCandidate(
    {
      category: "process",
      slug,
      title,
      description: "desc",
      when: "a thing happens",
      then: "warn",
      evidence: [{ kind: "file", path: "guide.md" }],
      provenance: { source: "llm-wiki-compiler" },
      confidence: "high",
    },
    FIXED_NOW,
  );
}

/** Make `.llmwiki/rule-candidates` a SYMLINK to the out-of-tree `outside` dir. */
async function symlinkRuleDirOutside(): Promise<void> {
  await mkdir(path.join(ctx.root, LLMWIKI_DIR), { recursive: true });
  await symlink(ctx.outside, path.join(ctx.root, LLMWIKI_DIR, "rule-candidates"), "dir");
}

/** Names of entries currently in the out-of-tree dir. */
async function outsideEntries(): Promise<string[]> {
  return readdir(ctx.outside);
}

describe("rule-candidate store — symlinked rule-candidates dir (tampering)", () => {
  it("writeRuleCandidate REFUSES and creates nothing outside root", async () => {
    await symlinkRuleDirOutside();
    await expect(writeRuleCandidate(ctx.root, candidateFor("Require tests"))).rejects.toBeInstanceOf(
      UnsafeCandidateDirError,
    );
    expect(await outsideEntries()).toHaveLength(0);
  });

  it("readRuleCandidate over the symlinked dir fails closed, leaving outside untouched", async () => {
    await writeFile(path.join(ctx.outside, "planted.json"), "{}", "utf8");
    await symlinkRuleDirOutside();
    await expect(readRuleCandidate(ctx.root, "planted")).rejects.toBeInstanceOf(UnsafeCandidateDirError);
    expect(await outsideEntries()).toEqual(["planted.json"]);
  });

  it("archiveRuleCandidate over the symlinked dir fails closed, leaving outside untouched", async () => {
    await writeFile(path.join(ctx.outside, "victim.json"), "{}", "utf8");
    await symlinkRuleDirOutside();
    await expect(archiveRuleCandidate(ctx.root, "victim")).rejects.toBeInstanceOf(UnsafeCandidateDirError);
    expect(await outsideEntries()).toEqual(["victim.json"]);
  });

  it("listRuleCandidates over the symlinked dir fails closed, never reading through it", async () => {
    await writeFile(path.join(ctx.outside, "leak.json"), "{}", "utf8");
    await symlinkRuleDirOutside();
    await expect(listRuleCandidates(ctx.root)).rejects.toBeInstanceOf(UnsafeCandidateDirError);
    expect(await outsideEntries()).toEqual(["leak.json"]);
  });
});

describe("rule-candidate store — normal dir regression", () => {
  it("round-trips a rule candidate identically through a REAL dir", async () => {
    const candidate = candidateFor("Require tests");
    const written = await writeRuleCandidate(ctx.root, candidate);
    expect(written).toContain(
      path.join(".llmwiki/rule-candidates", `${candidateFileId(candidate.id)}.json`),
    );
    const loaded = await readRuleCandidate(ctx.root, candidateFileId(candidate.id));
    expect(loaded).toEqual(candidate);
    expect(await listRuleCandidates(ctx.root)).toHaveLength(1);
  });
});

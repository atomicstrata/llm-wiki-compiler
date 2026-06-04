/**
 * Tests for the radar W2 rule-candidate pipeline: extraction → candidate →
 * approve → export. The LLM tool call is stubbed via vi.spyOn on the shared
 * `callClaude` helper (the same mock pattern used by review.test.ts), so no
 * network call is made and the extracted rule is deterministic.
 *
 * The shape assertions verify the emitted record matches Atomic Radar's
 * `RuleCandidate` contract exactly: camelCase keys, `status: "proposed"`,
 * tagged evidence, the `proposed` rule fields, and a stamped provenance.modelId.
 */

import { describe, it, expect } from "vitest";
import { extractRuleCandidates } from "../src/compiler/rule-extractor.js";
import {
  listRuleCandidates,
  setRuleCandidateStatus,
  validateRuleCandidate,
} from "../src/compiler/rule-candidates.js";
import {
  buildRuleCandidatesJson,
  collectRuleCandidatesForExport,
} from "../src/export/rule-candidates-json.js";
import { candidateFileId } from "../src/utils/candidate-store.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import {
  restoreProviderEnvAfterEach,
  seedRuleSource as seedSource,
  stubRuleExtraction,
} from "./fixtures/rule-extraction.js";
import type { RuleCandidate } from "../src/utils/rule-types.js";

const FIXED_NOW = "2026-05-31T00:00:00.000Z";

/** Candidate ids carry a content-hash suffix so distinct rules never collide. */
const CANDIDATE_ID_RE = /^rulecand\.process\.require-tests-before-merge-[a-f0-9]{8}$/;

restoreProviderEnvAfterEach();

describe("rule-candidate extraction", () => {
  const ctx = useTempRoot(["sources"]);

  it("emits a RuleCandidate matching the Radar contract shape", async () => {
    await seedSource(ctx.dir);
    await stubRuleExtraction();

    const result = await extractRuleCandidates(ctx.dir, FIXED_NOW);
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;

    expect(candidate.id).toMatch(CANDIDATE_ID_RE);
    expect(candidate.status).toBe("proposed");
    expect(candidate.confidence).toBe("high");
    expect(candidate.createdAt).toBe(FIXED_NOW);
    expect(validateRuleCandidate(candidate)).toBeNull();
    assertProposedRule(candidate);
    assertEvidenceAndProvenance(candidate);
  });

  it("persists the candidate JSON and lists it back", async () => {
    await seedSource(ctx.dir);
    await stubRuleExtraction();

    await extractRuleCandidates(ctx.dir, FIXED_NOW);
    const listed = await listRuleCandidates(ctx.dir);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.proposed.id).toBe(`rule.${listed[0]!.id.slice("rulecand.".length)}`);
  });
});

describe("rule-candidate approve + export", () => {
  const ctx = useTempRoot(["sources"]);

  it("approve flips status to approved", async () => {
    await seedSource(ctx.dir);
    await stubRuleExtraction();
    const { candidates } = await extractRuleCandidates(ctx.dir, FIXED_NOW);
    const fileId = candidateFileId(candidates[0]!.id);

    const updated = await setRuleCandidateStatus(ctx.dir, fileId, "approved");
    expect(updated!.status).toBe("approved");

    const listed = await listRuleCandidates(ctx.dir);
    expect(listed[0]!.status).toBe("approved");
  });

  it("export emits a JSON array of approved RuleCandidate records", async () => {
    await seedSource(ctx.dir);
    await stubRuleExtraction();
    const { candidates } = await extractRuleCandidates(ctx.dir, FIXED_NOW);
    const fileId = candidateFileId(candidates[0]!.id);
    await setRuleCandidateStatus(ctx.dir, fileId, "approved");

    const approved = await collectRuleCandidatesForExport(ctx.dir, "approved");
    const json = JSON.parse(buildRuleCandidatesJson(approved)) as RuleCandidate[];
    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(1);
    expect(json[0]!.status).toBe("approved");
    expect(json[0]!.proposed.version).toBe(1);
    expect(json[0]!.evidence[0]).toEqual({ kind: "file", path: "guide.md", lineStart: 1, lineEnd: 2 });
  });
});

/** Assert the `proposed` rule sub-object matches the contract. */
function assertProposedRule(candidate: RuleCandidate): void {
  expect(candidate.proposed).toEqual({
    id: `rule.${candidate.id.slice("rulecand.".length)}`,
    category: "process",
    title: "Require tests before merge",
    description: "All PRs must include passing tests.",
    when: "a pull request is opened without test changes",
    then: "warn",
    version: 1,
  });
}

/** Assert tagged evidence + provenance stamp (modelId from W4 resolver). */
function assertEvidenceAndProvenance(candidate: RuleCandidate): void {
  expect(candidate.evidence).toEqual([
    { kind: "file", path: "guide.md", lineStart: 1, lineEnd: 2 },
  ]);
  expect(candidate.provenance.source).toBe("llm-wiki-compiler");
  expect(typeof candidate.provenance.modelId).toBe("string");
  expect(candidate.provenance.modelId!.length).toBeGreaterThan(0);
  expect(candidate.provenance.modelVersion).toBe("v1");
}

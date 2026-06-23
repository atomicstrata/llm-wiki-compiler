/**
 * Unit tests for the rule-candidate id/category/validation helpers (rule pipeline).
 *
 * These guard the producer↔the rule importer contract: category alphabet, collision-free
 * ids, evidence-span sanity, and the producer-side mirror of the rule importer's import
 * gate (so the compiler never "successfully" emits a candidate the rule importer rejects).
 */

import { describe, it, expect } from "vitest";
import {
  buildRuleCandidate,
  buildRuleSlug,
  sanitizeRuleCategory,
  validateRuleCandidate,
} from "../src/compiler/rule-candidates.js";
import { parseRules } from "../src/compiler/rule-prompts.js";
import type { RuleCandidate } from "../src/utils/rule-types.js";

const NOW = "2026-05-31T00:00:00.000Z";

function candidate(category: string, slug: string): RuleCandidate {
  return buildRuleCandidate(
    {
      category,
      slug,
      title: "T",
      description: "d",
      when: "w",
      then: "warn",
      evidence: [{ kind: "file", path: "guide.md" }],
      provenance: { source: "llm-wiki-compiler" },
      confidence: "high",
    },
    NOW,
  );
}

describe("sanitizeRuleCategory", () => {
  it("collapses hyphen/space runs to underscores (the rule importer's [a-z0-9_] alphabet)", () => {
    expect(sanitizeRuleCategory("Code Review")).toBe("code_review");
    expect(sanitizeRuleCategory("ci/cd pipeline")).toBe("ci_cd_pipeline");
  });

  it("falls back to 'general' for an empty result", () => {
    expect(sanitizeRuleCategory("!!!")).toBe("general");
  });
});

describe("buildRuleSlug", () => {
  it("appends an 8-hex content hash so same-title rules never collide", () => {
    const a = buildRuleSlug("Require tests", "sourceA\nwhen\nthen");
    const b = buildRuleSlug("Require tests", "sourceB\nwhen\nthen");
    expect(a).toMatch(/^require-tests-[a-f0-9]{8}$/);
    expect(a).not.toBe(b);
  });
});

describe("validateRuleCandidate", () => {
  it("accepts a sanitized multi-word category", () => {
    expect(validateRuleCandidate(candidate("code_review", "x-abcd1234"))).toBeNull();
  });

  it("rejects a hyphen in the category segment (the rule importer would refuse it)", () => {
    expect(validateRuleCandidate(candidate("code-review", "x-abcd1234"))).toContain("candidate id");
  });

  it("rejects non-https url evidence", () => {
    const c = candidate("process", "x-abcd1234");
    c.evidence = [{ kind: "url", url: "http://example.com" }];
    expect(validateRuleCandidate(c)).toContain("https");
  });

  it("rejects an over-cap predicate", () => {
    const c = candidate("process", "x-abcd1234");
    c.proposed.when = "x".repeat(513);
    expect(validateRuleCandidate(c)).toContain("when");
  });

  it("rejects malformed proposed-rule objects before export", () => {
    const c = candidate("process", "x-abcd1234") as unknown as Record<string, unknown>;
    c.proposed = {};
    expect(validateRuleCandidate(c as RuleCandidate)).toContain("proposed.id");
  });

  it("rejects mismatched candidate/proposed ids", () => {
    const c = candidate("process", "x-abcd1234");
    c.proposed.id = "rule.other.x-abcd1234";
    expect(validateRuleCandidate(c)).toContain("does not match");
  });

  it("rejects Windows drive-absolute and UNC file evidence paths via shared helper", () => {
    const driveAbsolute = candidate("process", "x-abcd1234");
    driveAbsolute.evidence = [{ kind: "file", path: "C:/secrets.md" }];
    expect(validateRuleCandidate(driveAbsolute)).toContain("unsafe");

    const unc = candidate("process", "x-abcd1234");
    unc.evidence = [{ kind: "file", path: "//host/share" }];
    expect(validateRuleCandidate(unc)).toContain("unsafe");
  });

  it("still accepts a legit file evidence path (regression: sources/x.md)", () => {
    const c = candidate("process", "x-abcd1234");
    c.evidence = [{ kind: "file", path: "sources/x.md" }];
    expect(validateRuleCandidate(c)).toBeNull();
  });
});

describe("parseRules evidence-span sanity", () => {
  it("drops an inverted span (end < start) rather than emitting it", () => {
    const raw = JSON.stringify({
      rules: [{
        category: "process", title: "T", description: "d", when: "w", then: "warn",
        confidence: "high", evidenceLineStart: 40, evidenceLineEnd: 7,
      }],
    });
    const [rule] = parseRules(raw);
    expect(rule!.evidenceLineStart).toBeUndefined();
    expect(rule!.evidenceLineEnd).toBeUndefined();
  });
});

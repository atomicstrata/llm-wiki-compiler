/**
 * Profile rule-tier declarations complete the linter's registry: every id the
 * profile pass can emit is declared beside its emitter in the shared vocabulary,
 * confidence is a stored judgement only when a numeric field is declared, and
 * an undeclared id is a configuration error rather than a silently dropped row.
 */
import { afterEach, expect, it, vi } from "vitest";
import { groupByDeclaredTier, UnknownLintRuleTierError } from "../src/linter/tiers.js";
import { declaredRuleTiers, lint } from "../src/linter/index.js";
import * as profileLint from "../src/profile/lint.js";
import * as profileLoader from "../src/profile/load.js";
import { profileRuleTiers } from "../src/profile/lint-registry.js";
import type { LintResult } from "../src/linter/types.js";
import type { ProfilePack } from "../src/profile/types.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";

const env = useLintTempRoot("tier-registry");
const profile: ProfilePack = { schemaVersion: 1, profileId: "tier-registry", entities: {
  notes: { directory: "wiki/notes" },
} };
afterEach(() => vi.restoreAllMocks());

it("refuses an undeclared profile finding instead of dropping it from every tier", async () => {
  const finding: LintResult = { rule: "future-rule", file: "page.md", severity: "warning", message: "Future" };
  expect(() => groupByDeclaredTier([finding], profileRuleTiers(profile))).toThrow(UnknownLintRuleTierError);
  expect(() => groupByDeclaredTier([finding], [])).toThrow("No declared tier for lint rule: future-rule");
  vi.spyOn(profileLoader, "loadProfile").mockResolvedValue({ profile, loadedFrom: ".llmwiki/profile.json", digest: "t" });
  vi.spyOn(profileLint, "collectProfileLintFindings").mockResolvedValue({ results: [finding], ruleTiers: [] });
  await expect(lint(env.dir)).rejects.toBeInstanceOf(UnknownLintRuleTierError);
});

it("keeps emission order when consecutive findings alternate tiers", () => {
  const det = (file: string): LintResult => ({ rule: "empty-page", file, severity: "warning", message: "" });
  const judge = (file: string): LintResult => ({ rule: "low-confidence", file, severity: "warning", message: "" });
  const declared = [{ rule: "empty-page", tier: "deterministic" as const }, { rule: "low-confidence", tier: "provider-judgement" as const }];
  const results = [det("a"), judge("a"), det("b"), judge("b")];
  const groups = groupByDeclaredTier(results, declared);
  expect(groups.map((g) => g.tier)).toEqual(["deterministic", "provider-judgement", "deterministic", "provider-judgement"]);
  expect(groups.flatMap((g) => g.results)).toEqual(results);
  groups.flatMap((g) => g.results).forEach((finding, i) => expect(finding).toBe(results[i]));
});

it("declares the default stored-judgement rules beside their functions", () => {
  expect(declaredRuleTiers().filter((r) => r.tier === "provider-judgement").map((r) => r.rule))
    .toEqual(["checkLowConfidencePages", "checkContradictedPages", "checkInferredWithoutCitations"]);
});

it("declares profile confidence only for a numeric field", () => {
  expect(profileRuleTiers(profile).some((r) => r.rule === "low-confidence")).toBe(false);
  profile.entities.notes.fields = { confidence: { type: "string" } };
  expect(profileRuleTiers(profile).some((r) => r.rule === "low-confidence")).toBe(false);
  profile.entities.notes.fields.confidence = { type: "number" };
  expect(profileRuleTiers(profile)).toContainEqual({ rule: "low-confidence", tier: "provider-judgement" });
  expect(profileRuleTiers(profile).filter((r) => r.rule === "low-confidence")).toHaveLength(1);
});

it("declares every structural and store health variant explicitly", () => {
  const rules = profileRuleTiers(profile);
  for (const rule of [
    "profile/invalid-directory", "profile/non-slug-safe-filename", "profile/slug-mismatch", "profile/field-violation",
    "invalid-lifecycle-state", "dangling-relation", "relation-store-torn", "relation-store-corrupt",
    "relation-store-too-new", "relation-store-symlink", "relation-store-graph-dir", "relation-profile-invalid",
    "lifecycle-relation-requirement-unmet", "lifecycle-relation-requirement-unverifiable",
    "event-chain-broken", "event-store-torn", "event-store-corrupt", "event-store-too-new", "event-store-symlink",
    "event-store-graph-dir", "event-store-private-dir", "event-store-full",
    "artifact-dangling", "artifact-unreadable", "artifact-bytes-tampered", "artifact-hash-mismatch",
    "artifact-schema-invalid", "artifact-store-unavailable", "gated-page-required-artifact-missing", "gated-page-required-artifact-wrong-type",
    "gated-page-required-artifact-unproven",
  ]) expect(rules).toContainEqual({ rule, tier: "deterministic" });
});

/**
 * @file test/artifact-requirement-lint.test.ts
 * @description Read-surface DETECTIVE lint for a LIVE gated page that does NOT
 * satisfy its artifact precondition — the backstop behind the write-time enforcer
 * (`src/artifacts/enforce-precondition.ts`). `transitionArtifactRequirements` was
 * previously consumed only by the load-validator and the write gate; no read
 * surface checked a page ALREADY sitting in a gated state. These tests pin the two
 * gaps `checkArtifactRefs`'s per-field HEALTH pass is blind to:
 *   (a) a page MISSING its required field entirely → `gated-page-required-artifact-missing`;
 *   (b) a page carrying a HEALTHY ref of the WRONG artifact type → `gated-page-required-artifact-wrong-type`
 *       (the health pass resolves it as its own type, sees it healthy, emits nothing).
 * A HEALTHY CORRECT ref emits NOTHING new (no double-report), and a default /
 * artifact-less profile emits zero findings (parity-safe). The new findings reach
 * the status / export / context read surfaces through the SAME
 * `snapshot.profile.problems` / warning channel the existing health findings use.
 */
import { describe, it, expect } from "vitest";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writeProfileFile, writeMarkdownPage } from "./fixtures/profile-fixtures.js";
import { seedArtifact } from "./fixtures/artifact-root.js";
import { formatArtifactRef } from "../src/artifacts/ref.js";
import { checkArtifactRefs } from "../src/profile/artifact-lint.js";
import { collectEntityPages } from "../src/profile/collect.js";
import { collectStatus } from "../src/status/collect.js";
import { exportJson } from "../src/commands/export.js";
import { buildContextPack } from "../src/context/build.js";
import {
  researchArtifactPreconditionProfile,
  multiTypeArtifactPreconditionProfile,
  RESEARCH_ARTIFACT_TYPE,
  OTHER_ARTIFACT_TYPE,
} from "./fixtures/artifact-precondition-profiles.js";
import type { LintResult } from "../src/linter/types.js";
import type { ProfilePack } from "../src/profile/types.js";

const MISSING = "gated-page-required-artifact-missing";
const WRONG_TYPE = "gated-page-required-artifact-wrong-type";
const STATE_PHRASE = 'required by lifecycle state "complete"';

/** Collect all artifact-lint findings for a materialized project (its profile drives the check). */
async function findingsFor(root: string, profile: ProfilePack): Promise<LintResult[]> {
  const { pages } = await collectEntityPages(root, profile);
  return checkArtifactRefs(root, pages, profile);
}

/** Only the NEW requirement-satisfaction findings (missing / wrong-type). */
function requirementFindings(findings: LintResult[]): LintResult[] {
  return findings.filter((f) => f.rule === MISSING || f.rule === WRONG_TYPE);
}

describe("gated-page artifact requirement — read-side detective lint", () => {
  it("(a) a live gated page MISSING its required field is flagged as an error", async () => {
    const profile = researchArtifactPreconditionProfile();
    const root = await makeTempRoot("req-lint-missing");
    await writeProfileFile(root, profile);
    await writeMarkdownPage(root, "wiki/experiments", "exp", "---\ntitle: E\nstage: complete\n---\n\nBody.\n");
    const found = requirementFindings(await findingsFor(root, profile));
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe(MISSING);
    expect(found[0].severity).toBe("error");
    expect(found[0].message).toContain(STATE_PHRASE);
  });

  it("(b) a live gated page carrying a HEALTHY WRONG-TYPE ref is flagged — coverage the health pass misses", async () => {
    const profile = multiTypeArtifactPreconditionProfile();
    const root = await makeTempRoot("req-lint-wrong-type");
    await writeProfileFile(root, profile);
    const ref = formatArtifactRef(await seedArtifact(root, OTHER_ARTIFACT_TYPE, "note", "a scratch note"));
    await writeMarkdownPage(root, "wiki/experiments", "exp", `---\ntitle: E\nstage: complete\nresult: ${ref}\n---\n\nBody.\n`);
    const all = await findingsFor(root, profile);
    expect(requirementFindings(all)).toHaveLength(1);
    expect(requirementFindings(all)[0].rule).toBe(WRONG_TYPE);
    expect(requirementFindings(all)[0].severity).toBe("error");
    // The healthy wrong-type ref emits NO artifact-health finding — the wrong-type finding is genuinely new.
    expect(all.filter((f) => f.rule.startsWith("artifact-"))).toHaveLength(0);
  });

  it("(c) a live gated page carrying a HEALTHY CORRECT ref emits NO new finding (no double-report)", async () => {
    const profile = researchArtifactPreconditionProfile();
    const root = await makeTempRoot("req-lint-correct");
    await writeProfileFile(root, profile);
    const ref = formatArtifactRef(await seedArtifact(root, RESEARCH_ARTIFACT_TYPE, "r1", '{"accuracy":0.9}'));
    await writeMarkdownPage(root, "wiki/experiments", "exp", `---\ntitle: E\nstage: complete\nresult: ${ref}\n---\n\nBody.\n`);
    const all = await findingsFor(root, profile);
    expect(requirementFindings(all)).toHaveLength(0);
    expect(all).toHaveLength(0); // healthy correct ref → the health pass is silent too
  });

  it("(d) a default / artifact-less profile emits zero findings (parity-safe early-out)", async () => {
    const profile: ProfilePack = { schemaVersion: 1, profileId: "artifactless", entities: { notes: { directory: "wiki/notes" } } };
    const root = await makeTempRoot("req-lint-artifactless");
    await writeProfileFile(root, profile);
    await writeMarkdownPage(root, "wiki/notes", "n1", "---\ntitle: N\n---\n\nBody.\n");
    expect(await findingsFor(root, profile)).toHaveLength(0);
  });
});

describe("gated-page artifact requirement — reaches every read surface", () => {
  it("a MISSING required artifact surfaces on status, export, and context alike", async () => {
    const profile = researchArtifactPreconditionProfile();
    const root = await makeTempRoot("req-lint-surfaces");
    await writeProfileFile(root, profile);
    await writeMarkdownPage(root, "wiki/experiments", "exp", "---\ntitle: E\nstage: complete\n---\n\nBody.\n");
    const status = (await collectStatus(root)).profile?.problems ?? [];
    const exported = (await exportJson(root)).profile?.problems ?? [];
    const context = (await buildContextPack({ root, prompt: "anything" })).warnings;
    expect(status.some((p) => p.kind === "artifact-store" && p.message.includes(STATE_PHRASE))).toBe(true);
    expect(exported.some((p) => p.kind === "artifact-store" && p.message.includes(STATE_PHRASE))).toBe(true);
    expect(context.some((w) => w.code === "artifact-ref-unhealthy" && w.message.includes(STATE_PHRASE))).toBe(true);
  });

  it("the context warning's umbrella wording stays honest for a MISSING ref (nothing was health-checked)", async () => {
    const profile = researchArtifactPreconditionProfile();
    const root = await makeTempRoot("req-lint-wording");
    await writeProfileFile(root, profile);
    await writeMarkdownPage(root, "wiki/experiments", "exp", "---\ntitle: E\nstage: complete\n---\n\nBody.\n");
    const context = (await buildContextPack({ root, prompt: "anything" })).warnings;
    const warning = context.find((w) => w.code === "artifact-ref-unhealthy");
    expect(warning?.message).toContain("failed verification");
    expect(warning?.message).not.toContain("failed health verification");
  });
});

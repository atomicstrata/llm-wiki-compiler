/**
 * The profile rule-tier registry must cover every id the profile lint modules can
 * EMIT, not just the ones a hand-written list remembers: an undeclared id makes
 * `lint` throw `UnknownLintRuleTierError` for any project whose profile reaches
 * that emitter. The first test derives the emitted set from the modules' own
 * source (`X_RULE = "..."` constants and `rule: "..."` literals). Ids emitted
 * elsewhere (`empty-page`, `malformed-claim-citation`) are imported constants,
 * so the registry cannot drift from them; ids built from closed unions
 * (`profile/<kind>`, artifact health) are exhaustive by type. The second
 * drives the one emitter a hand-written list once missed, the execution-
 * provenance arm, through the real `lint` / `lintByTier` entry points.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { lint, lintByTier } from "../src/linter/index.js";
import { formatArtifactRef } from "../src/artifacts/ref.js";
import { profileRuleTiers } from "../src/profile/lint-registry.js";
import type { ProfilePack } from "../src/profile/types.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writeProfileFile, writeMarkdownPage } from "./fixtures/profile-fixtures.js";
import { seedArtifact } from "./fixtures/artifact-root.js";
import { researchArtifactPreconditionProfile, RESEARCH_ARTIFACT_TYPE } from "./fixtures/artifact-precondition-profiles.js";

const PROFILE_SRC_DIR = path.resolve(import.meta.dirname, "../src/profile");
const RULE_LITERAL = /(?:_RULE = |rule: )"([^"]+)"/g;
const UNPROVEN = "gated-page-required-artifact-unproven";

/** Every quoted rule id the profile modules assign to a constant or emit inline. */
async function emittedProfileRuleLiterals(): Promise<string[]> {
  const ids = new Set<string>();
  for (const name of await readdir(PROFILE_SRC_DIR)) {
    if (!name.endsWith(".ts")) continue;
    const source = await readFile(path.join(PROFILE_SRC_DIR, name), "utf8");
    for (const match of source.matchAll(RULE_LITERAL)) ids.add(match[1]);
  }
  return [...ids].sort();
}

/** The research precondition profile with the execution-provenance arm declared on its requirement. */
function provenanceArmedProfile(): ProfilePack {
  const profile = researchArtifactPreconditionProfile();
  profile.entities.experiments.lifecycle!.transitionArtifactRequirements = {
    complete: [{
      field: "result", artifactType: RESEARCH_ARTIFACT_TYPE,
      executionProvenance: { actionId: "demo.execute", slugInputField: "slug", resultOutputId: "result" },
    }],
  };
  return profile;
}

it("declares every rule id the profile lint modules emit", async () => {
  const profile: ProfilePack = { schemaVersion: 1, profileId: "emitters", entities: {
    notes: { directory: "wiki/notes", fields: { confidence: { type: "number" } } },
  } };
  const declared = new Set(profileRuleTiers(profile).map((entry) => entry.rule));
  const emitted = await emittedProfileRuleLiterals();
  expect(emitted).toContain(UNPROVEN); // the scan reached the emitters, not an empty directory
  expect(emitted.filter((rule) => !declared.has(rule))).toEqual([]);
});

it("lints an unproven required artifact as a deterministic finding instead of throwing", async () => {
  const profile = provenanceArmedProfile();
  const root = await makeTempRoot("req-lint-unproven-tier");
  await writeProfileFile(root, profile);
  const ref = formatArtifactRef(await seedArtifact(root, RESEARCH_ARTIFACT_TYPE, "r1", '{"accuracy":0.9}'));
  await writeMarkdownPage(root, "wiki/experiments", "exp", `---\ntitle: E\nstage: complete\nresult: ${ref}\n---\n\nBody.\n`);
  // A fresh root has no vouching run: the verifier DENIES, so the arm emits its error.
  const summary = await lint(root);
  expect(summary.results.filter((finding) => finding.rule === UNPROVEN)).toHaveLength(1);
  expect(summary.errors).toBe(1);
  const tiered = await lintByTier(root);
  expect(tiered.deterministic.map((finding) => finding.rule)).toContain(UNPROVEN);
  expect(tiered.providerJudgement).toHaveLength(0);
});

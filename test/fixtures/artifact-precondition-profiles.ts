/**
 * @file test/fixtures/artifact-precondition-profiles.ts
 * @description Two DELIBERATELY DISSIMILAR non-default profile packs that both
 * declare a required-artifact precondition (`transitionArtifactRequirements`) on a
 * terminal lifecycle state. They exist to prove the Slice 7.3 write-time artifact
 * precondition is PROFILE-AGNOSTIC (audit C1): the research-flavored pack and the
 * unrelated newsroom pack drive the SAME enforcer/loader with no core edit. Both
 * are profile-only (no seeded pages), so they never disturb the shared research
 * fixture or its seeds. Pure data — touches no `src/` internals.
 */
import type { ProfilePack } from "../../src/profile/types.js";

/** The research pack's single artifact type + its leaf filename. */
export const RESEARCH_ARTIFACT_TYPE = "experiment-result";
export const RESEARCH_ARTIFACT_FILE = "result.json";
/** The newsroom pack's single artifact type + its leaf filename. */
export const NEWSROOM_ARTIFACT_TYPE = "factcheck-report";
export const NEWSROOM_ARTIFACT_FILE = "report.json";
/** A SECOND, in-field-scope-but-wrong artifact type for the multi-type type-confusion fixture. */
export const OTHER_ARTIFACT_TYPE = "scratch-note";
export const OTHER_ARTIFACT_FILE = "note.txt";

/**
 * A minimal `research-artifact` pack: an `experiments` entity whose terminal
 * `complete` state REQUIRES a healthy `result` artifactRef. The `result` field is
 * optional in general (so a non-terminal page needs no ref) but the precondition
 * gates entry to `complete`. Distinct `profileId` avoids colliding with the shared
 * `research` fixture.
 */
export function researchArtifactPreconditionProfile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research-artifact",
    entities: {
      experiments: {
        directory: "wiki/experiments",
        requiredFields: ["title", "stage"],
        fields: {
          title: { type: "string" },
          stage: { type: "enum", enum: ["running", "complete"] },
          result: { type: "artifactRef", artifactTypes: [RESEARCH_ARTIFACT_TYPE] },
        },
        lifecycle: {
          field: "stage",
          initial: "running",
          terminal: ["complete"],
          transitions: { running: ["complete"] },
          transitionArtifactRequirements: {
            complete: [{ field: "result", artifactType: RESEARCH_ARTIFACT_TYPE }],
          },
        },
      },
    },
    artifacts: {
      [RESEARCH_ARTIFACT_TYPE]: {
        fileName: RESEARCH_ARTIFACT_FILE,
        contentKind: "json",
        maxBytes: 65536,
        metadata: { accuracy: { type: "number", required: true } },
      },
    },
  };
}

/**
 * A MULTI-TYPE-scoped variant of the research pack: the `result` field's
 * `artifactTypes` scope admits BOTH `experiment-result` and `scratch-note`, yet the
 * `complete` precondition requires specifically `experiment-result`. This is a valid,
 * M1-accepted shape (a field may hold several types; one precondition pins one of them)
 * that exercises the enforcer's type-binding: a page pinning a healthy `scratch-note`
 * satisfies the field's scope but must NOT satisfy an `experiment-result` requirement.
 */
export function multiTypeArtifactPreconditionProfile(): ProfilePack {
  // Derive from the single-type research pack, then WIDEN the `result` field scope to
  // admit a second type and DECLARE that type — the precondition still pins
  // `experiment-result` alone. Composition (not a re-spelled literal) keeps the shared
  // entity/lifecycle shape in one place.
  const base = researchArtifactPreconditionProfile();
  base.profileId = "research-artifact-multitype";
  base.entities.experiments.fields.result = { type: "artifactRef", artifactTypes: [RESEARCH_ARTIFACT_TYPE, OTHER_ARTIFACT_TYPE] };
  base.artifacts![OTHER_ARTIFACT_TYPE] = { fileName: OTHER_ARTIFACT_FILE, contentKind: "text", maxBytes: 65536 };
  return base;
}

/**
 * A deliberately UNRELATED `newsroom` pack: a `stories` entity whose terminal
 * `published` state REQUIRES a healthy `factcheck` artifactRef. Shares NO
 * vocabulary with the research pack — if the enforcer/loader can drive this with
 * no core change, the machinery is not research-shaped (C1).
 */
export function newsroomArtifactPreconditionProfile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "newsroom",
    entities: {
      stories: {
        directory: "wiki/stories",
        requiredFields: ["headline", "state"],
        fields: {
          headline: { type: "string" },
          state: { type: "enum", enum: ["drafting", "published"] },
          factcheck: { type: "artifactRef", artifactTypes: [NEWSROOM_ARTIFACT_TYPE] },
        },
        lifecycle: {
          field: "state",
          initial: "drafting",
          terminal: ["published"],
          transitions: { drafting: ["published"] },
          transitionArtifactRequirements: {
            published: [{ field: "factcheck", artifactType: NEWSROOM_ARTIFACT_TYPE }],
          },
        },
      },
    },
    artifacts: {
      [NEWSROOM_ARTIFACT_TYPE]: {
        fileName: NEWSROOM_ARTIFACT_FILE,
        contentKind: "json",
        maxBytes: 65536,
        metadata: { verdict: { type: "string", required: true } },
      },
    },
  };
}

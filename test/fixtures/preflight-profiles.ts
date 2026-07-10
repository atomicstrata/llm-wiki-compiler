/**
 * @file test/fixtures/preflight-profiles.ts
 * @description Combined fixture profiles for the CLP 7.7 preflight-proof slice.
 * Each profile pack declares BOTH a `publish-pipeline` workflow whose `produce`
 * stage writes a typed artifact (the P-A produce leg, mirroring
 * `artifact-seam-fixtures.ts`) AND a gated lifecycle precondition requiring a
 * healthy pinned ref of that same artifact type before a `draft` entity may
 * enter its terminal state (mirroring
 * `artifact-precondition-profiles.ts::newsroomArtifactPreconditionProfile`).
 * Two deliberately dissimilar profiles (research / newsroom), built from the
 * SAME `buildPreflightPack` so they cannot drift apart (DRY) — later tasks in
 * this slice (pin, require) build on top of these fixtures and the exported
 * names here, so they are a contract: do not rename.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProfilePack } from "../../src/profile/types.js";
import { runCLI, expectCLIExit } from "./run-cli.js";
import { formatArtifactRef } from "../../src/artifacts/ref.js";
import { hashArtifactBody } from "../../src/artifacts/store.js";
import { driveStage, pageSubmitArgs } from "./research-workflow.js";

/** The out-of-band trusted-write grant every preflight CLI call needs (no staged-review path for artifacts). */
export const PREFLIGHT_GRANT: NodeJS.ProcessEnv = { LLMWIKI_TRUSTED_WRITE: "*" };

/**
 * One combined preflight profile descriptor: names every id/slug/field the
 * shared `buildPreflightPack` needs to assemble a full, valid {@link ProfilePack}.
 * Kept as plain DATA (never branched on by id in test bodies) so
 * `describe.each`/`preflightProfilePack` can drive both profiles uniformly.
 */
export interface PreflightProfile {
  id: string;
  workflowId: "publish-pipeline";
  produceStageId: "produce";
  draftStageId: "draft";
  publishStageId: "publish";
  entityType: string;
  slug: string;
  lifecycleField: string;
  initialState: string;
  gatedState: string;
  headlineField: string;
  artifactType: string;
  artifactRefField: string;
  artifactBody: string;
  artifactFileName: string;
}

/** The research-flavored descriptor: `experiments`/`experiment-result`, `running` -> `complete`. */
const RESEARCH_PREFLIGHT: PreflightProfile = {
  id: "research-preflight",
  workflowId: "publish-pipeline",
  produceStageId: "produce",
  draftStageId: "draft",
  publishStageId: "publish",
  entityType: "experiments",
  slug: "exp-1",
  lifecycleField: "stage",
  initialState: "running",
  gatedState: "complete",
  headlineField: "title",
  artifactType: "experiment-result",
  artifactRefField: "result",
  artifactBody: `{"accuracy":0.9}`,
  artifactFileName: "result.json",
};

/** The DISSIMILAR newsroom descriptor: `stories`/`factcheck-report`, `drafting` -> `published`. */
const NEWSROOM_PREFLIGHT: PreflightProfile = {
  id: "newsroom-preflight",
  workflowId: "publish-pipeline",
  produceStageId: "produce",
  draftStageId: "draft",
  publishStageId: "publish",
  entityType: "stories",
  slug: "story-1",
  lifecycleField: "state",
  initialState: "drafting",
  gatedState: "published",
  headlineField: "headline",
  artifactType: "factcheck-report",
  artifactRefField: "factcheck",
  artifactBody: `{"verdict":"true"}`,
  artifactFileName: "report.json",
};

/** The two descriptors, for `describe.each`/loops that must cover both profiles. */
export const PREFLIGHT_PROFILES: PreflightProfile[] = [RESEARCH_PREFLIGHT, NEWSROOM_PREFLIGHT];

/**
 * The artifact type's required top-level JSON metadata field, keyed by
 * `artifactType` — fixture DATA, never a core branch. Research pins a numeric
 * `accuracy`; newsroom pins a string `verdict`.
 */
function metadataFor(artifactType: string): Record<string, { type: "number" | "string"; required: true }> {
  return artifactType === "experiment-result"
    ? { accuracy: { type: "number", required: true } }
    : { verdict: { type: "string", required: true } };
}

/**
 * Build the full combined {@link ProfilePack} for descriptor `p`: an entity
 * type with a gated lifecycle requiring a healthy pinned artifact ref, the
 * artifact type declaration, and a `publish-pipeline` workflow whose `produce`
 * stage may write that artifact and whose `draft`/`publish` stages write the
 * entity. Shared by both profiles so they cannot drift (DRY).
 */
export function buildPreflightPack(p: PreflightProfile): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: p.id,
    entities: {
      [p.entityType]: {
        directory: `wiki/${p.entityType}`,
        requiredFields: [p.headlineField, p.lifecycleField],
        fields: {
          [p.headlineField]: { type: "string" },
          [p.lifecycleField]: { type: "enum", enum: [p.initialState, p.gatedState] },
          [p.artifactRefField]: { type: "artifactRef", artifactTypes: [p.artifactType] },
        },
        lifecycle: {
          field: p.lifecycleField,
          initial: p.initialState,
          terminal: [p.gatedState],
          transitions: { [p.initialState]: [p.gatedState] },
          transitionArtifactRequirements: {
            [p.gatedState]: [{ field: p.artifactRefField, artifactType: p.artifactType }],
          },
        },
      },
    },
    artifacts: {
      [p.artifactType]: {
        fileName: p.artifactFileName,
        contentKind: "json",
        maxBytes: 65536,
        metadata: metadataFor(p.artifactType),
      },
    },
    workflows: {
      "publish-pipeline": {
        stages: [
          { id: p.produceStageId, reads: [], writes: [], artifactWrites: [p.artifactType] },
          { id: p.draftStageId, reads: [], writes: [p.entityType] },
          { id: p.publishStageId, reads: [], writes: [p.entityType] },
        ],
      },
    },
  } as ProfilePack;
}

/** The pack for descriptor `p` — so tests never branch on `p.id`. */
export function preflightProfilePack(p: PreflightProfile): ProfilePack {
  return buildPreflightPack(p);
}

/**
 * Build an `artifact` submit arg vector: seeds `body` under a `--body-file` in
 * the temp root and returns the `workflow submit` args to write it as
 * `artifactType/slug`. Mirrors `research-workflow.ts`'s `pageSubmitArgs`/
 * `relationSubmitArgs` shape for the artifact kind.
 */
export async function artifactSubmitArgs(
  root: string,
  runId: string,
  artifactType: string,
  slug: string,
  body: string,
): Promise<string[]> {
  const file = path.join(root, `artifact-body-${slug}.json`);
  await writeFile(file, body, "utf8");
  return [
    "workflow", "submit", runId,
    "--kind", "artifact",
    "--artifact-type", artifactType,
    "--slug", slug,
    "--body-file", file,
  ];
}

/**
 * Drive the workflow's `produce` stage: submit the artifact output, then
 * advance ONCE. Unlike `driveStage` (`research-workflow.ts`), this does NOT
 * advance FIRST. The `produce` stage declares no entity `writes` (only
 * `artifactWrites`), and it is already the run's CURRENT stage right after
 * `startRun` — a leading `advance` call would see an empty `writes` set and
 * treat the stage as trivially satisfied, stepping past it before the
 * artifact is ever submitted. Submitting directly against the current stage,
 * then advancing once, records the output and steps cleanly to the next stage.
 */
export async function driveProduceStage(
  root: string,
  runId: string,
  submitArgs: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  expectCLIExit(await runCLI(submitArgs, root, env), 0);
  expectCLIExit(await runCLI(["workflow", "advance", runId], root, env), 0);
}

/**
 * The hash-pinned ref a produced artifact resolves to, computed INDEPENDENTLY
 * of any run output — the same way an author would compute it by hand from the
 * artifact body they were handed. Used by tests as the value to MANUALLY pin
 * into a downstream page's frontmatter (never read back from `run.outputs`).
 */
export function computePinnedRef(p: PreflightProfile): string {
  return formatArtifactRef({
    artifactType: p.artifactType,
    slug: p.slug,
    sha256: hashArtifactBody(p.artifactBody),
  });
}

/**
 * Drive the workflow's `produce` stage (via {@link driveProduceStage} — submit-
 * then-advance, no leading advance; see that function's doc for why a leading
 * advance would silently skip the artifact-only stage) and then the `draft`
 * stage (via the normal advance->submit->advance `driveStage`, since `draft`
 * declares entity `writes` and is not subject to the same gap). Leaves the run
 * parked at `publish`, with the entity page created at its INITIAL (ungated)
 * lifecycle state.
 *
 * THE MANUAL PIN RIDES IN THE DRAFT BODY. IFF `pin`, the draft page's create
 * frontmatter also sets `artifactRefField: computePinnedRef(p)` — the produced
 * ref, computed by the test, templated into the page-write surface exactly as
 * an author drafting the page would. This passes the draft's field contract
 * because `entityFieldViolations` (`src/profile/artifact-ref-validate.ts`)
 * validates an artifactRef field for FORMAT + declared/in-scope type ONLY (no
 * health / disk resolution); the artifact HEALTH check fires later, at the
 * gated `lifecycle-transition` (`enforceArtifactPreconditions`). So an UNPINNED
 * draft (`pin:false`) is still a valid page at `initialState` — it simply lacks
 * the ref the downstream gate requires.
 */
export async function driveProduceThenDraft(
  root: string,
  runId: string,
  p: PreflightProfile,
  grant: NodeJS.ProcessEnv,
  pin: boolean,
): Promise<void> {
  await driveProduceStage(root, runId, await artifactSubmitArgs(root, runId, p.artifactType, p.slug, p.artifactBody), grant);
  const lines = [`${p.headlineField}: Draft`, `${p.lifecycleField}: ${p.initialState}`];
  if (pin) lines.push(`${p.artifactRefField}: "${computePinnedRef(p)}"`);
  await driveStage(root, runId, await pageSubmitArgs(root, runId, p.entityType, p.slug, lines.join("\n"), ""), grant);
}

/**
 * Build the `publish` stage's submit args: a `lifecycle-transition` into
 * `p.gatedState`. IDENTICAL for ACCEPT and DENY — the difference is purely
 * whether the earlier draft ({@link driveProduceThenDraft}) pinned the ref. The
 * lifecycle-transition write path re-reads the page's CURRENT frontmatter fresh
 * off disk (`src/trust/lifecycle-apply.ts::resolvePageContext`) into the meta
 * the artifact-existence gate inspects, so the gate sees whatever the draft
 * wrote: a healthy pinned ref (ACCEPT) or none (DENY).
 *
 * A repeated `page`-kind submit against the SAME already-created entity/slug is
 * NOT usable for the transition itself: the workflow page-write planner
 * (`src/workflows/stage-output.ts::planStagePage`) never sets `allowOverwrite`,
 * so it always collision-blocks an existing target (parks, never applies). The
 * `lifecycle-transition` kind is the codebase's intended mechanism for moving an
 * already-created page across lifecycle states (mirrored by every
 * `lifecycleSubmit` call in `research-workflow.ts`).
 */
export function publishTransitionArgs(root: string, runId: string, p: PreflightProfile): string[] {
  void root; // signature parity with the drive helpers; a transition needs no seeded file
  return [
    "workflow", "submit", runId,
    "--kind", "lifecycle-transition",
    "--entity-type", p.entityType,
    "--slug", p.slug,
    "--to-state", p.gatedState,
  ];
}

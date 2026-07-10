/**
 * @file test/gated-state-entry-priority.test.ts
 * @description Proves the `enforceGatedStateEntry` seam surfaces the WORST outcome
 * across its two enforcers — any Unmet (deny) beats any Unverifiable (park), which
 * beats a pass — rather than throwing whichever enforcer happens to run first. Before
 * this fix a relation PARK preempted an artifact DENY, so a run with a genuine
 * violation would park/retry instead of hard-failing (the D-C.1 trust-path honesty
 * gap). Exercises a fixture lifecycle state that declares BOTH
 * `transitionRelationRequirements` and `transitionArtifactRequirements` — the existing
 * artifact-precondition fixtures declare none, so this is the first coverage of the
 * two enforcers composing on ONE state. The artifact enforcer is wrapped with a
 * pass-through spy (delegates to the real implementation) so the relation-deny case
 * can prove the SHORT-CIRCUIT: the artifact enforcer is never even invoked, not just
 * that its error lost a priority race.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EntityId, LifecycleDef, ProfilePack } from "../src/profile/types.js";
import { writeMarkdownPage } from "./fixtures/profile-fixtures.js";
import { appendRelation } from "../src/relations/store.js";
import { RELATIONS_FILE, WIKI_GRAPH_DIR } from "../src/utils/constants.js";
import { artifactPaths, hashArtifactBody, writeArtifactFiles, type ArtifactManifest } from "../src/artifacts/store.js";
import { formatArtifactRef } from "../src/artifacts/ref.js";
import { RelationPreconditionUnmetError, RelationPreconditionUnverifiableError } from "../src/relations/enforce-precondition.js";
import { ArtifactPreconditionUnmetError, ArtifactPreconditionUnverifiableError, enforceArtifactPreconditions } from "../src/artifacts/enforce-precondition.js";
import { enforceGatedStateEntry, type GatedStateEntryInput } from "../src/trust/gated-state-entry.js";

// Pass-through spy: delegates to the real enforcer so every case's actual
// deny/park/pass behavior is unchanged, while letting tests assert call counts.
vi.mock("../src/artifacts/enforce-precondition.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/artifacts/enforce-precondition.js")>();
  return { ...actual, enforceArtifactPreconditions: vi.fn(actual.enforceArtifactPreconditions) };
});
vi.mock("../src/relations/enforce-precondition.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/relations/enforce-precondition.js")>();
  return { ...actual, enforceRelationPreconditions: vi.fn(actual.enforceRelationPreconditions) };
});

const ARTIFACT_TYPE = "experiment-result";
const ARTIFACT_FILE = "result.json";
const IDEA_SLUG = "real-idea";
const EXP_SLUG = "exp";
const BODY = `{"accuracy":0.9}`;

/** A `complete` state gated on BOTH a relation-count req and an artifact req. */
const GATED_LIFECYCLE: LifecycleDef = {
  field: "stage",
  initial: "running",
  terminal: ["complete"],
  transitions: { running: ["complete"] },
  transitionRelationRequirements: {
    complete: [{ relationType: "tests", role: "from", otherTypes: ["ideas"], minCount: 1 }],
  },
  transitionArtifactRequirements: {
    complete: [{ field: "result", artifactType: ARTIFACT_TYPE }],
  },
};

/** The profile pack declaring both the `tests` relation and the artifact type above. */
function bothGatedProfile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "gated-both",
    entities: {
      ideas: { directory: "wiki/ideas", requiredFields: ["title"], fields: { title: { type: "string" } } },
      experiments: {
        directory: "wiki/experiments",
        requiredFields: ["title", "stage"],
        fields: {
          title: { type: "string" },
          stage: { type: "enum", enum: ["running", "complete"] },
          result: { type: "artifactRef", artifactTypes: [ARTIFACT_TYPE] },
        },
        lifecycle: GATED_LIFECYCLE,
      },
    },
    relations: {
      tests: { from: ["experiments"], to: ["ideas"], direction: "directed", attributes: { metric: { type: "string" } } },
    },
    artifacts: {
      [ARTIFACT_TYPE]: { fileName: ARTIFACT_FILE, contentKind: "json", maxBytes: 65536, metadata: { accuracy: { type: "number", required: true } } },
    },
  };
}

/** Write a store-sick relations file (interior bad record → Unverifiable/park). */
async function writeCorruptRelationStore(root: string): Promise<void> {
  await mkdir(path.join(root, WIKI_GRAPH_DIR), { recursive: true });
  // Header parses, then an INTERIOR bad record (not the final line) → RelationStoreCorruptError.
  const corrupt = '{"kind":"relation-store-header","schemaVersion":1}\nnot-a-valid-record\nalso-garbage\n';
  await writeFile(path.join(root, RELATIONS_FILE), corrupt, "utf8");
}

/** Seed a real `ideas` page and a qualifying `tests` relation from `EXP_SLUG` (relation pass). */
async function seedQualifyingRelation(root: string, profile: ProfilePack): Promise<void> {
  await writeMarkdownPage(root, "wiki/ideas", IDEA_SLUG, "---\ntitle: A Real Idea\n---\n\nIdea body.\n");
  await appendRelation(root, profile, {
    type: "tests",
    from: `experiments/${EXP_SLUG}` as EntityId,
    to: `ideas/${IDEA_SLUG}` as EntityId,
    attributes: { metric: "f1" },
  });
}

/** Seed a healthy artifact and return its ref (for a passing `meta.result`). */
async function seedHealthyArtifact(root: string): Promise<string> {
  const sha256 = hashArtifactBody(BODY);
  const manifest: ArtifactManifest = { artifactType: ARTIFACT_TYPE, slug: EXP_SLUG, sha256, bytes: Buffer.byteLength(BODY, "utf8"), contentKind: "json", writtenAt: new Date().toISOString() };
  await writeArtifactFiles(root, artifactPaths(root, ARTIFACT_TYPE, EXP_SLUG, ARTIFACT_FILE), BODY, manifest);
  return formatArtifactRef({ artifactType: ARTIFACT_TYPE, slug: EXP_SLUG, sha256 });
}

/** Build the `enforceGatedStateEntry` input for `EXP_SLUG` entering `complete`. */
function input(root: string, profile: ProfilePack, meta: Record<string, unknown>): GatedStateEntryInput {
  return { root, profile, entityType: "experiments", slug: EXP_SLUG, enteredState: "complete", lifecycle: GATED_LIFECYCLE, meta };
}

describe("enforceGatedStateEntry surfaces deny-beats-park", () => {
  let root = "";
  const profile = bothGatedProfile();

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "gated-entry-priority-"));
  });
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    vi.mocked(enforceArtifactPreconditions).mockClear();
  });

  it("RED case: relation PARK + artifact DENY throws the DENY, not the park", async () => {
    await writeCorruptRelationStore(root);
    await expect(enforceGatedStateEntry(input(root, profile, {})))
      .rejects.toBeInstanceOf(ArtifactPreconditionUnmetError);
  });

  it("relation DENY short-circuits: throws RelationPreconditionUnmetError and never reaches the artifact enforcer", async () => {
    // No relations file at all → readLiveValidRelations returns [] → 0 < minCount 1 → Unmet.
    await expect(enforceGatedStateEntry(input(root, profile, {})))
      .rejects.toBeInstanceOf(RelationPreconditionUnmetError);
    expect(enforceArtifactPreconditions).not.toHaveBeenCalled();
  });

  it("relation PASS + artifact DENY throws the artifact denial", async () => {
    await seedQualifyingRelation(root, profile);
    await expect(enforceGatedStateEntry(input(root, profile, {})))
      .rejects.toBeInstanceOf(ArtifactPreconditionUnmetError);
  });

  it("relation PARK + artifact PASS throws the relation park", async () => {
    await writeCorruptRelationStore(root);
    const ref = await seedHealthyArtifact(root);
    await expect(enforceGatedStateEntry(input(root, profile, { result: ref })))
      .rejects.toBeInstanceOf(RelationPreconditionUnverifiableError);
  });

  it("relation PASS + artifact PARK throws the artifact park", async () => {
    await seedQualifyingRelation(root, profile);
    const ref = await seedHealthyArtifact(root);
    // Corrupt the manifest AFTER a healthy write → artifact reads as Unverifiable (park).
    const { manifestPath } = artifactPaths(root, ARTIFACT_TYPE, EXP_SLUG, ARTIFACT_FILE);
    await writeFile(manifestPath, "{ not json", "utf8");
    await expect(enforceGatedStateEntry(input(root, profile, { result: ref })))
      .rejects.toBeInstanceOf(ArtifactPreconditionUnverifiableError);
  });

  it("both PASS: returns normally", async () => {
    await seedQualifyingRelation(root, profile);
    const ref = await seedHealthyArtifact(root);
    await expect(enforceGatedStateEntry(input(root, profile, { result: ref }))).resolves.toBeUndefined();
  });

  it("a non-precondition error from an enforcer propagates unchanged (never swallowed)", async () => {
    const bug = new TypeError("planted non-precondition bug");
    vi.mocked(enforceArtifactPreconditions).mockRejectedValueOnce(bug);
    await seedQualifyingRelation(root, profile); // relation passes so the artifact enforcer runs
    await expect(enforceGatedStateEntry(input(root, profile, {}))).rejects.toBe(bug);
  });
});

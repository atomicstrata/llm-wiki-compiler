/**
 * @file test/artifacts/artifact-ref-layer-b.test.ts
 * @description Layer B (profile-aware) `artifactRef` validation:
 * {@link validateArtifactRefsAgainstProfile} rejects a ref whose `artifactType`
 * is undeclared or out of a field's declared scope, on top of the structural
 * (Layer A) checks from Task 3.
 *
 * The second half proves the SAME undeclared-type ref is rejected IDENTICALLY
 * across every write surface able to carry one — a typed page write, a
 * lifecycle transition, and a relation attribute — via the shared
 * {@link entityFieldViolations} wrapper wired into each call site (the
 * call-site matrix in the Task 4 brief).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { validateArtifactRefsAgainstProfile } from "../../src/profile/artifact-ref-validate.js";
import { stageEntityPage, EntityFieldContractError } from "../../src/trust/staging.js";
import { applyTypedCandidate } from "../../src/trust/promote.js";
import { applyLifecycleLocked, LifecycleTransitionUnavailableError } from "../../src/trust/lifecycle-apply.js";
import { LifecycleTransitionError } from "../../src/profile/lifecycle.js";
import { planRelationMutation } from "../../src/trust/relation-plan.js";
import { appendRelation } from "../../src/relations/store.js";
import { RelationEndpointError } from "../../src/relations/types.js";
import { validateRelationAgainstProfile } from "../../src/relations/relation-contract.js";
import { writeProfileFile, writeMarkdownPage } from "../fixtures/profile-fixtures.js";
import type { ProfilePack, FieldDef } from "../../src/profile/types.js";
import type { EntityId, RelationRef } from "../../src/relations/types.js";

void LifecycleTransitionUnavailableError; // imported for type-narrowing readability only

const HEX = "a".repeat(64);
const profile = {
  schemaVersion: 1,
  profileId: "p",
  entities: {},
  artifacts: { "experiment-result": { fileName: "result.json", contentKind: "json", maxBytes: 1024 } },
} as unknown as ProfilePack;
const scoped: Record<string, FieldDef> = { result: { type: "artifactRef", artifactTypes: ["experiment-result"] } };

describe("Layer B profile-aware artifactRef validation", () => {
  it("accepts a declared, in-scope ref", () => {
    expect(validateArtifactRefsAgainstProfile(profile, scoped, { result: `experiment-result/probe@sha256:${HEX}` })).toEqual([]);
  });
  it("rejects an undeclared artifact type", () => {
    expect(validateArtifactRefsAgainstProfile(profile, scoped, { result: `unknown-type/probe@sha256:${HEX}` }).length).toBe(1);
  });
  it("rejects an out-of-scope declared type", () => {
    const p2 = { ...profile, artifacts: { ...profile.artifacts, other: { fileName: "o.json", contentKind: "json", maxBytes: 1024 } } } as ProfilePack;
    expect(validateArtifactRefsAgainstProfile(p2, scoped, { result: `other/probe@sha256:${HEX}` }).length).toBe(1);
  });
  it("checks EVERY element of an artifactRef[] value", () => {
    const arr: Record<string, FieldDef> = { results: { type: "artifactRef[]", artifactTypes: ["experiment-result"] } };
    const bad = { results: [`experiment-result/a@sha256:${HEX}`, `unknown-type/b@sha256:${HEX}`] };
    expect(validateArtifactRefsAgainstProfile(profile, arr, bad).length).toBe(1);
  });
});

/** A ref that structurally parses but points at an undeclared artifact type. */
const UNDECLARED_REF = `unknown-type/probe@sha256:${HEX}`;

/** A papers-only profile declaring `resultRef` (artifactRef) but NO artifact types at all. */
const PAGE_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "artifact-page",
  entities: {
    papers: {
      directory: "wiki/papers",
      requiredFields: ["title"],
      fields: { title: { type: "string" }, resultRef: { type: "artifactRef" } },
    },
  },
};

/** A `papers` profile with a `status` lifecycle plus the same undeclared-scope `resultRef` field. */
const LIFECYCLE_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "artifact-lifecycle",
  entities: {
    papers: {
      directory: "wiki/papers",
      requiredFields: ["status"],
      fields: {
        status: { type: "enum", enum: ["draft", "published"] },
        resultRef: { type: "artifactRef" },
      },
      lifecycle: { field: "status", initial: "draft", terminal: ["published"], transitions: { draft: ["published"] } },
    },
  },
};

/** An experiments→ideas profile whose `tests` relation carries an artifactRef attribute. */
const RELATION_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "artifact-relation",
  entities: { experiments: { directory: "wiki/experiments" }, ideas: { directory: "wiki/ideas" } },
  relations: {
    tests: {
      from: ["experiments"],
      to: ["ideas"],
      direction: "directed",
      attributes: { evidenceRef: { type: "artifactRef" } },
    },
  },
};

describe("Layer B rejects the SAME undeclared-type ref identically across write surfaces", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "artifact-layer-b-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("page write (staging) — rejects an undeclared-type ref", async () => {
    const body = `---\ntitle: Paper\nresultRef: ${UNDECLARED_REF}\n---\n\nBody.\n`;
    await expect(
      stageEntityPage(root, { entityType: "papers", slug: "p1", body, profile: PAGE_PROFILE, existingStagedCount: 0 }),
    ).rejects.toBeInstanceOf(EntityFieldContractError);
  });

  it("page write (promote / validateLiveTypedPage) — rejects an undeclared-type ref", async () => {
    await writeProfileFile(root, PAGE_PROFILE);
    const body = `---\ntitle: Paper\nresultRef: ${UNDECLARED_REF}\n---\n\nBody.\n`;
    await expect(
      applyTypedCandidate(root, { slug: "p1", body, targetEntityType: "papers" } as never),
    ).rejects.toBeInstanceOf(EntityFieldContractError);
  });

  it("lifecycle transition — rejects a page carrying an undeclared-type ref", async () => {
    await writeProfileFile(root, LIFECYCLE_PROFILE);
    await writeMarkdownPage(root, "wiki/papers", "p1", `---\nstatus: draft\nresultRef: ${UNDECLARED_REF}\n---\n\nBody.\n`);
    await expect(
      applyLifecycleLocked(root, { kind: "lifecycle-transition", entityType: "papers", slug: "p1", toState: "published" }),
    ).rejects.toBeInstanceOf(LifecycleTransitionError);
  });

  it("relation attribute (planner) — denies an undeclared-type ref", () => {
    const plan = planRelationMutation(RELATION_PROFILE, {
      type: "tests",
      from: "experiments/e1" as EntityId,
      to: "ideas/i1" as EntityId,
      attributes: { evidenceRef: UNDECLARED_REF },
    });
    expect(plan.decision).toBe("deny");
  });

  it("relation attribute (store) — rejects an undeclared-type ref, writing nothing", async () => {
    await expect(
      appendRelation(root, RELATION_PROFILE, {
        type: "tests",
        from: "experiments/e1" as EntityId,
        to: "ideas/i1" as EntityId,
        attributes: { evidenceRef: UNDECLARED_REF },
      }),
    ).rejects.toBeInstanceOf(RelationEndpointError);
  });

  it("relation attribute (read/live-valid) — flags a stored ref whose type is no longer declared", () => {
    const stored: RelationRef = {
      id: "rel_01",
      type: "tests",
      from: "experiments/e1" as EntityId,
      to: "ideas/i1" as EntityId,
      attributes: { evidenceRef: UNDECLARED_REF },
      contentHash: "h",
    };
    expect(validateRelationAgainstProfile(stored, RELATION_PROFILE).length).toBeGreaterThan(0);
  });
});

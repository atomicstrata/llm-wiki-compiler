/**
 * @file test/storage/typed-promotion-binding.test.ts
 * @description Typed-page promotion as ONE body per layer over its own reads, with
 * every root form delegating over per-call local defaults:
 * `enforceRelationPreconditionsFrom` (`RelationPreconditionReads`),
 * `enforceArtifactPreconditionsFrom` (`ArtifactPreconditionReads`),
 * `enforceGatedStateEntryFrom` (`GatedStateEntryChecks`),
 * `assertBodyLifecycleFrom`/`validateLiveTypedPageFrom` (`TypedPageValidationReads`,
 * whose previous-state read is `readPrevLifecycleStateFrom`), and
 * `planTypedCandidateWith`/`applyTypedCandidateWith`/`promoteCandidateLockedWith`
 * (`TypedPromotionSteps`).
 *
 * HOW IT IS BUILT. Memory doubles log every call to pin order, early-outs and
 * refusals. The artifact case runs the REAL local artifact store on a temporary
 * project (healthy, missing and corrupt pins) with a logging provenance double. A
 * double proves only the body's decisions; confinement, no-follow and the
 * incumbent disk behaviour stay with the existing gated, lifecycle, promote,
 * review and workflow suites, which run alongside this file.
 */

import { writeFile } from "node:fs/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { formatArtifactRef } from "../../src/artifacts/ref.js";
import { diskArtifactStoreReads } from "../../src/artifacts/resolve.js";
import { artifactPaths, hashArtifactBody, writeArtifactFiles } from "../../src/artifacts/store.js";
import { ArtifactPreconditionUnmetError, ArtifactPreconditionUnverifiableError, enforceArtifactPreconditionsFrom, type ArtifactPreconditionReads } from "../../src/artifacts/enforce-precondition.js";
import type { ExecutionProvenanceReads } from "../../src/artifacts/execution-provenance.js";
import { readPrevLifecycleStateFrom, type PrevLifecyclePageReads } from "../../src/profile/lifecycle-read.js";
import * as lifecycleRead from "../../src/profile/lifecycle-read.js";
import type { LifecycleDef, ProfilePack } from "../../src/profile/types.js";
import {
  RelationPreconditionUnmetError, RelationPreconditionUnverifiableError, enforceRelationPreconditionsFrom, type RelationPreconditionReads,
} from "../../src/relations/enforce-precondition.js";
import { enforceGatedStateEntryFrom, type GatedStateEntryChecks } from "../../src/trust/gated-state-entry.js";
import {
  CandidateProfileError, CandidatePromotionBlockedError, applyTypedCandidateWith, planTypedCandidateWith, promoteCandidateLockedWith,
  type TypedPromotionSteps,
} from "../../src/trust/promote.js";
import { assertBodyLifecycleFrom, validateLiveTypedPage, validateLiveTypedPageFrom, type TypedPageValidationReads } from "../../src/trust/typed-page-validate.js";
import * as markdown from "../../src/utils/markdown.js";
import type { ReviewCandidate } from "../../src/utils/types.js";
import { writeMarkdownPage } from "../fixtures/profile-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";

const ART = "experiment-result";
const tracker = tempRootTracker();
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => tracker.cleanup());

const LIFECYCLE: LifecycleDef = {
  field: "stage", initial: "running", terminal: ["complete"], transitions: { running: ["complete"] },
  transitionRelationRequirements: { complete: [{ relationType: "tests", role: "from", otherTypes: ["ideas"], minCount: 1 }] },
  transitionArtifactRequirements: { complete: [{ field: "result", artifactType: ART }] },
};
const PROFILE: ProfilePack = {
  schemaVersion: 1, profileId: "typed-promotion",
  entities: {
    ideas: { directory: "wiki/ideas", requiredFields: ["title"], fields: { title: { type: "string" } } },
    experiments: {
      directory: "wiki/experiments", requiredFields: ["title", "stage"], lifecycle: LIFECYCLE,
      fields: { title: { type: "string" }, stage: { type: "enum", enum: ["running", "complete"] }, result: { type: "artifactRef", artifactTypes: [ART] } },
    },
  },
  relations: { tests: { from: ["experiments"], to: ["ideas"], direction: "directed" } },
  artifacts: { [ART]: { fileName: "result.json", contentKind: "json", maxBytes: 65536, metadata: {} } },
};
const EXP = PROFILE.entities.experiments!;
const page = (stage: string) => `---\ntitle: E\nstage: ${stage}\n---\nbody\n`;
const coded = (code: string): Error => Object.assign(new Error(code), { code });
const unasked = async (): Promise<never> => { throw new Error("not asked"); };
const entry = (meta: Record<string, unknown> = {}) => ({ profile: PROFILE, entityType: "experiments", slug: "exp", enteredState: "complete", lifecycle: LIFECYCLE, meta });

describe("gated state entry: one ranking body over the two checks", () => {
  const relUnmet = new RelationPreconditionUnmetError([]), relPark = new RelationPreconditionUnverifiableError(new Error("sick"));
  const artUnmet = new ArtifactPreconditionUnmetError(["no ref"]), artPark = new ArtifactPreconditionUnverifiableError("unreadable");
  const run = async (relation?: Error, artifact?: Error) => {
    const log: string[] = [];
    const checks: GatedStateEntryChecks = {
      relations: async (args) => { log.push(`relations ${"meta" in args}`); if (relation) throw relation; },
      artifacts: async (args) => { log.push(`artifacts ${"meta" in args}`); if (artifact) throw artifact; },
    };
    const outcome = await enforceGatedStateEntryFrom(checks, entry()).then(() => "pass", (error: unknown) => error);
    return [outcome, log];
  };

  it("G1 a relation denial short-circuits; an artifact denial outranks a relation park; then relation park, then artifact park", async () => {
    expect(await run(relUnmet, artUnmet)).toEqual([relUnmet, ["relations false"]]);
    expect(await run(relPark, artUnmet)).toEqual([artUnmet, ["relations false", "artifacts true"]]);
    expect(await run(relPark, artPark)).toEqual([relPark, ["relations false", "artifacts true"]]);
    expect(await run(undefined, artPark)).toEqual([artPark, ["relations false", "artifacts true"]]);
    expect(await run()).toEqual(["pass", ["relations false", "artifacts true"]]);
  });

  it("G2 an unknown error propagates immediately and is never ranked", async () => {
    const bug = new TypeError("bug");
    expect(await run(bug, artUnmet)).toEqual([bug, ["relations false"]]);
    expect(await run(relPark, bug)).toEqual([bug, ["relations false", "artifacts true"]]);
  });
});

describe("relation enforcer: one body over the graph read and the page look", () => {
  const reads = (log: string[], store: () => Promise<string | null>): RelationPreconditionReads => ({
    graph: { readStore: async () => { log.push("readStore"); return store(); } },
    pages: { readEntityPage: async () => { log.push("readEntityPage"); return { kind: "absent" }; } },
  });

  it("R1 reads nothing without a requirement, maps only a store fault to Unverifiable, and an empty store to Unmet", async () => {
    const log: string[] = [];
    await enforceRelationPreconditionsFrom(reads(log, unasked), { ...entry(), enteredState: "running" });
    expect(log).toEqual([]);
    await expect(enforceRelationPreconditionsFrom(reads(log, async () => { throw coded("EACCES"); }), entry())).rejects.toBeInstanceOf(RelationPreconditionUnverifiableError);
    await expect(enforceRelationPreconditionsFrom(reads(log, async () => { throw new TypeError("bug"); }), entry())).rejects.toThrow(TypeError);
    await expect(enforceRelationPreconditionsFrom(reads(log, async () => null), entry())).rejects.toBeInstanceOf(RelationPreconditionUnmetError);
    expect(log).toEqual(["readStore", "readStore", "readStore"]);
  });
});

describe("artifact enforcer: one body over the real store and a provenance double", () => {
  const BODY = `{"accuracy":0.9}`;
  async function seeded(): Promise<{ root: string; ref: string }> {
    const root = await tracker.create("typed-promotion-");
    const sha256 = hashArtifactBody(BODY);
    await writeArtifactFiles(root, artifactPaths(root, ART, "exp", "result.json"), BODY,
      { artifactType: ART, slug: "exp", sha256, bytes: Buffer.byteLength(BODY), contentKind: "json", writtenAt: new Date(0).toISOString() });
    return { root, ref: formatArtifactRef({ artifactType: ART, slug: "exp", sha256 }) };
  }
  const provenance = (log: string[]): ExecutionProvenanceReads => ({
    scanInventory: async () => { log.push("scan"); return { manifests: [], problems: [] }; }, readInitialInput: unasked, resolveRun: unasked,
  });
  const gate = (reqs: NonNullable<LifecycleDef["transitionArtifactRequirements"]>["complete"]) => ({ ...LIFECYCLE, transitionArtifactRequirements: { complete: reqs } });
  const ARM = { actionId: "run-experiment", slugInputField: "slug", resultOutputId: "result" };

  it("A1 asks provenance ONLY over a healthy pin, and a denial outranks a park across requirements", async () => {
    const { root, ref } = await seeded();
    const log: string[] = [];
    const reads = (): ArtifactPreconditionReads => ({ store: diskArtifactStoreReads(root), provenance: provenance(log) });
    const withArm = { ...entry({ result: ref }), lifecycle: gate([{ field: "result", artifactType: ART, executionProvenance: ARM }]) };
    await expect(enforceArtifactPreconditionsFrom(reads(), withArm)).rejects.toThrow("no succeeded 'run-experiment' run");
    expect(log).toEqual(["scan"]);
    await enforceArtifactPreconditionsFrom(reads(), { ...entry({ result: ref }) });
    await writeFile(artifactPaths(root, ART, "exp", "result.json").manifestPath, "{ not json", "utf8");
    await expect(enforceArtifactPreconditionsFrom(reads(), withArm)).rejects.toBeInstanceOf(ArtifactPreconditionUnverifiableError);
    const mixed = { ...entry({ result: ref }), lifecycle: gate([{ field: "result", artifactType: ART }, { field: "absent", artifactType: ART }]) };
    const denied = await enforceArtifactPreconditionsFrom(reads(), mixed).catch((error: unknown) => error);
    expect([denied instanceof ArtifactPreconditionUnmetError, (denied as ArtifactPreconditionUnmetError).unmet.length, log]).toEqual([true, 1, ["scan"]]);
  });

  it("A2 reads nothing without a requirement, and refuses a type-mismatched pin before any store read", async () => {
    const store = { artifactAt: () => { throw new Error("not asked"); } };
    const reads: ArtifactPreconditionReads = { store, provenance: provenance([]) };
    await enforceArtifactPreconditionsFrom(reads, { ...entry(), enteredState: "running" });
    const foreign = formatArtifactRef({ artifactType: "other-type", slug: "exp", sha256: "a".repeat(64) });
    await expect(enforceArtifactPreconditionsFrom(reads, entry({ result: foreign }))).rejects.toThrow("pins a other-type artifact");
  });
});

/** Memory validation reads over one previous page text (`null` = no page). */
function validation(log: string[], previous: string | null): TypedPageValidationReads {
  return {
    resolvePage: async (def, slug) => { log.push(`resolve ${def.directory}/${slug}`); return previous === null ? null : "P"; },
    readPage: async () => { log.push("read"); return previous!; },
    enforceEntry: async (input) => { log.push(`enter ${input.enteredState}`); },
  };
}

describe("typed-page validation: one body over the previous-state looks and the gate", () => {
  it("V1 contract, then the previous state, then the gate; no lifecycle and a failed contract read nothing", async () => {
    const log: string[] = [];
    await validateLiveTypedPageFrom(validation(log, page("running")), { profile: PROFILE, entityType: "experiments", slug: "exp", body: page("complete"), def: EXP });
    expect(log).toEqual(["resolve wiki/experiments/exp", "read", "enter complete"]);
    log.length = 0;
    await validateLiveTypedPageFrom(validation(log, null), { profile: PROFILE, entityType: "ideas", slug: "i", body: "---\ntitle: I\n---\n", def: PROFILE.entities.ideas! });
    await expect(validateLiveTypedPageFrom(validation(log, null), { profile: PROFILE, entityType: "experiments", slug: "exp", body: "---\ntitle: E\n---\n", def: EXP }))
      .rejects.toThrow("profile field contract");
    await expect(validateLiveTypedPageFrom(validation(log, page("complete")), { profile: PROFILE, entityType: "experiments", slug: "exp", body: page("running"), def: EXP }))
      .rejects.toThrow("profile lifecycle");
    expect(log).toEqual(["resolve wiki/experiments/exp", "read"]);
  });

  it("V2 the previous-state read keeps the incumbent meaning: absent and unreadable ('') are both a create", async () => {
    const reads = (text: string | null): PrevLifecyclePageReads => validation([], text);
    expect([await readPrevLifecycleStateFrom(reads(null), EXP, "exp", "stage"), await readPrevLifecycleStateFrom(reads(""), EXP, "exp", "stage"),
      await readPrevLifecycleStateFrom(reads(page("running")), EXP, "exp", "stage")]).toEqual([undefined, undefined, "running"]);
    await expect(assertBodyLifecycleFrom(reads(""), "experiments", "exp", { stage: "running" }, EXP)).resolves.toBeUndefined();
  });

  it("V3 the root form reaches the incumbent resolve, safe read and gated seam with this root", async () => {
    const root = await tracker.create("typed-promotion-");
    await writeMarkdownPage(root, "wiki/experiments", "exp", page("running"));
    const resolve = vi.spyOn(lifecycleRead, "resolveConfinedEntityPage"), read = vi.spyOn(markdown, "safeReadFile");
    await expect(validateLiveTypedPage({ root, profile: PROFILE, entityType: "experiments", slug: "exp", body: page("complete"), def: EXP }))
      .rejects.toBeInstanceOf(RelationPreconditionUnmetError); // no relation store: the gate ran on disk and denied
    expect(resolve.mock.calls).toEqual([[root, EXP, "exp"]]);
    expect(read.mock.calls.map(([file]) => String(file).endsWith("wiki/experiments/exp.md"))).toEqual([true]);
  });
});

describe("typed promotion: one body per step over the promotion steps", () => {
  const CANDIDATE = { id: "c1", slug: "exp", body: page("running"), targetEntityType: "experiments" } as unknown as ReviewCandidate;
  function steps(log: string[], over: Partial<TypedPromotionSteps> = {}): TypedPromotionSteps {
    return {
      loadProfile: async () => { log.push("profile"); return { profile: PROFILE } as never; },
      validation: validation(log, null),
      planPage: async (request) => { log.push(`plan ${request.origin} ${request.reviewRouted} ${request.allowOverwrite}`); return { planned: [{ op: "w" }] } as never; },
      assertCustody: async () => { log.push("custody"); },
      applyPlanned: async () => { log.push("apply"); },
      readCandidate: async () => { log.push("read-candidate"); return CANDIDATE; },
      deleteCandidate: async () => { log.push("delete"); },
      ...over,
    };
  }

  it("P1 custody, profile, validation, the review plan, then apply; the locked promotion deletes only after the apply", async () => {
    const log: string[] = [];
    expect(await applyTypedCandidateWith(steps(log), CANDIDATE)).toBe("wiki/experiments/exp.md");
    expect(log).toEqual(["custody", "profile", "resolve wiki/experiments/exp", "enter running", "plan review false true", "apply"]);
    log.length = 0;
    await promoteCandidateLockedWith(steps(log), "c1");
    expect([log[0], log.at(-2), log.at(-1)]).toEqual(["read-candidate", "apply", "delete"]);
  });

  it("P2 refuses a missing profile, an undeclared type and an empty plan before any write; a missing or untyped candidate before any apply", async () => {
    const log: string[] = [];
    await expect(planTypedCandidateWith(steps(log, { loadProfile: async () => undefined }), CANDIDATE)).rejects.toBeInstanceOf(CandidateProfileError);
    await expect(planTypedCandidateWith(steps(log), { ...CANDIDATE, targetEntityType: "nope" })).rejects.toThrow('does not declare entity type "nope"');
    await expect(applyTypedCandidateWith(steps(log, { planPage: async () => ({ planned: [] }) as never }), CANDIDATE)).rejects.toBeInstanceOf(CandidatePromotionBlockedError);
    await expect(promoteCandidateLockedWith(steps(log, { readCandidate: async () => null }), "gone")).rejects.toThrow("staged candidate not found: gone");
    await expect(promoteCandidateLockedWith(steps(log, { readCandidate: async () => ({ ...CANDIDATE, targetEntityType: undefined }) }), "c1"))
      .rejects.toThrow("is not a typed entity page");
    expect(log.filter((entry) => entry === "apply" || entry === "delete")).toEqual([]);
  });
});

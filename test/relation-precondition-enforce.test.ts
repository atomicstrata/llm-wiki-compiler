/**
 * @file test/relation-precondition-enforce.test.ts
 * @description Integration coverage for the shared relation-count precondition
 * ENFORCER wired into the two LIVE-APPLY paths (through the REAL relation store +
 * real apply), proving a typed page can enter a gated lifecycle state LIVE only
 * when the live relation graph satisfies its declared
 * `transitionRelationRequirements`:
 *
 *  - the lifecycle-transition apply path ({@link transitionLifecycle}) and the
 *    promote-to-live path ({@link promoteStagedEntityPage}) both DENY a gated
 *    write whose precondition is unmet, leaving the page unchanged/not-live;
 *  - object-scope, endpoint-existence, and distinct-endpoint counting are honored
 *    through the real store;
 *  - staging a candidate that WILL enter a gated state is NOT blocked — enforcement
 *    is at APPLY, not stage — so stage → add relation → promote succeeds;
 *  - a store-sick relation store PARKS the write with a DISTINCT unverifiable error;
 *  - non-gated / early-out writes incur no relation read and are unaffected.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { EntityId, ProfilePack } from "../src/profile/types.js";
import { transitionLifecycle } from "../src/trust/lifecycle-transition.js";
import { stageEntityPage, promoteStagedEntityPage } from "../src/trust/staging.js";
import { appendRelation } from "../src/relations/store.js";
import {
  RelationPreconditionUnmetError,
  RelationPreconditionUnverifiableError,
  isStoreUnavailable,
} from "../src/relations/enforce-precondition.js";
import { writeProfileFile, writeMarkdownPage, gatedResearchProfile } from "./fixtures/profile-fixtures.js";
import { RELATIONS_FILE, WIKI_GRAPH_DIR } from "../src/utils/constants.js";

const EXP = "exp";
const IDEA = "real";

/**
 * The gated research profile under test (`experiments.complete` gated on a
 * `tests`→`ideas` precondition), from the shared fixture so its shape is not
 * re-spelled per suite. `complete` declares no evidence requirement, so the
 * relation precondition is the SOLE gate on entering it.
 */
const gatedProfile = gatedResearchProfile;

/** An experiment page body at the given lifecycle stage. */
const expBody = (stage: string): string => `---\ntitle: An Experiment\nstage: ${stage}\n---\n\nExperiment body here.\n`;

/** The absolute on-disk path of the `EXP` experiment page. */
const expPath = (root: string): string => path.join(root, "wiki/experiments", `${EXP}.md`);

/** Materialize a gated project: the profile, one idea page, and `EXP` at `running`. */
async function makeGatedRoot(pack: ProfilePack): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rel-precond-"));
  await writeProfileFile(root, pack);
  await writeMarkdownPage(root, "wiki/ideas", IDEA, "---\ntitle: A Real Idea\n---\n\nIdea body here.\n");
  await writeMarkdownPage(root, "wiki/experiments", EXP, expBody("running"));
  return root;
}

/** Append one `tests` relation `experiments/<from>` → `ideas/<to>` with a `metric`. */
function addTests(root: string, pack: ProfilePack, fromSlug: string, toSlug: string, metric = "f1"): Promise<unknown> {
  return appendRelation(root, pack, {
    type: "tests",
    from: `experiments/${fromSlug}` as EntityId,
    to: `ideas/${toSlug}` as EntityId,
    attributes: { metric },
  });
}

/**
 * Wire a FRESH gated project (at `minCount`) before each test in the enclosing
 * `describe`, tearing it down after — returns live getters for the current root +
 * pack so every suite shares ONE setup/teardown definition.
 */
function useGatedProject(minCount = 1): { root: () => string; pack: () => ProfilePack } {
  let root = "";
  let pack: ProfilePack;
  beforeEach(async () => { pack = gatedProfile(minCount); root = await makeGatedRoot(pack); });
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  return { root: () => root, pack: () => pack };
}

/** Assert transitioning `EXP`→`complete` is DENIED as Unmet and leaves the page byte-identical. */
async function expectCompleteDeniedUnchanged(root: string): Promise<void> {
  const before = await readFile(expPath(root), "utf8");
  await expect(transitionLifecycle(root, "experiments", EXP, "complete"))
    .rejects.toBeInstanceOf(RelationPreconditionUnmetError);
  expect(await readFile(expPath(root), "utf8")).toBe(before);
}

describe("lifecycle-transition apply — gated by relation precondition", () => {
  const ctx = useGatedProject(1);

  it("denies complete without a qualifying relation, page UNCHANGED", async () => {
    await expectCompleteDeniedUnchanged(ctx.root());
  });

  it("admits complete once the qualifying relation exists", async () => {
    await addTests(ctx.root(), ctx.pack(), EXP, IDEA);
    await transitionLifecycle(ctx.root(), "experiments", EXP, "complete");
    expect(await readFile(expPath(ctx.root()), "utf8")).toContain("stage: complete");
  });

  it("does not count a relation to a NONEXISTENT idea endpoint (dangling dropped)", async () => {
    await addTests(ctx.root(), ctx.pack(), EXP, "ghost"); // ideas/ghost has no page
    await expectCompleteDeniedUnchanged(ctx.root());
  });

  it("object-scope: another experiment's relation does not admit THIS one", async () => {
    await writeMarkdownPage(ctx.root(), "wiki/experiments", "exp2", expBody("running"));
    await addTests(ctx.root(), ctx.pack(), "exp2", IDEA); // belongs to exp2, not EXP
    await expectCompleteDeniedUnchanged(ctx.root());
  });
});

describe("distinct-endpoint counting (minCount 2)", () => {
  const ctx = useGatedProject(2);

  it("two relations to the SAME idea do not satisfy minCount 2", async () => {
    await addTests(ctx.root(), ctx.pack(), EXP, IDEA, "f1");
    await addTests(ctx.root(), ctx.pack(), EXP, IDEA, "accuracy"); // distinct record, SAME endpoint
    await expectCompleteDeniedUnchanged(ctx.root());
  });

  it("two relations to DISTINCT ideas satisfy minCount 2", async () => {
    await writeMarkdownPage(ctx.root(), "wiki/ideas", "second", "---\ntitle: Second Idea\n---\n\nSecond body.\n");
    await addTests(ctx.root(), ctx.pack(), EXP, IDEA, "f1");
    await addTests(ctx.root(), ctx.pack(), EXP, "second", "f1");
    await transitionLifecycle(ctx.root(), "experiments", EXP, "complete");
    expect(await readFile(expPath(ctx.root()), "utf8")).toContain("stage: complete");
  });
});

describe("promote (create) — gated by relation precondition", () => {
  const NEW = "brand-new-exp";
  const body = "---\ntitle: Brand New\nstage: complete\n---\n\nA created experiment body.\n";
  const ctx = useGatedProject(1);

  const stageNew = (): Promise<{ id: string }> =>
    stageEntityPage(ctx.root(), { entityType: "experiments", slug: NEW, body, profile: ctx.pack(), existingStagedCount: 0 });
  const newPath = (): string => path.join(ctx.root(), "wiki/experiments", `${NEW}.md`);

  it("denies promoting a create into gated complete without the relation; page NOT live", async () => {
    const staged = await stageNew();
    await expect(promoteStagedEntityPage(ctx.root(), staged.id))
      .rejects.toBeInstanceOf(RelationPreconditionUnmetError);
    expect(existsSync(newPath())).toBe(false);
  });

  it("stage does NOT enforce — stage → add relation → promote SUCCEEDS", async () => {
    const staged = await stageNew(); // staging a to-be-gated create must NOT be blocked
    await addTests(ctx.root(), ctx.pack(), NEW, IDEA);
    await promoteStagedEntityPage(ctx.root(), staged.id);
    expect(await readFile(newPath(), "utf8")).toBe(body);
  });
});

describe("store-sick relation store PARKS the write (unverifiable, distinct)", () => {
  const ctx = useGatedProject(1);

  it("a corrupt relation store throws Unverifiable (not Unmet), page UNCHANGED", async () => {
    const root = ctx.root();
    await mkdir(path.join(root, WIKI_GRAPH_DIR), { recursive: true });
    // Header parses, then an INTERIOR bad record → RelationStoreCorruptError.
    const corrupt = '{"kind":"relation-store-header","schemaVersion":1}\nnot-a-valid-record\nalso-garbage\n';
    await writeFile(path.join(root, RELATIONS_FILE), corrupt, "utf8");
    const before = await readFile(expPath(root), "utf8");
    await expect(transitionLifecycle(root, "experiments", EXP, "complete"))
      .rejects.toBeInstanceOf(RelationPreconditionUnverifiableError);
    expect(await readFile(expPath(root), "utf8")).toBe(before);
  });

  it("classifies a raw OS I/O errno (EACCES/EMFILE/EIO) as unverifiable, but not a plain programming error", () => {
    const errno = (code: string): Error => Object.assign(new Error(code), { code });
    // The store read rethrows raw errno errors (permission-blocked/fd-exhausted/mid-read
    // fault) that have no typed class; those are legitimately "cannot verify" → PARK.
    for (const code of ["EACCES", "EMFILE", "ENFILE", "EIO"]) {
      expect(isStoreUnavailable(errno(code))).toBe(true);
    }
    // A genuine bug (no errno `.code`) must still propagate, not be masked as a park.
    expect(isStoreUnavailable(new Error("logic bug"))).toBe(false);
    expect(isStoreUnavailable(new TypeError("bad shape"))).toBe(false);
  });
});

describe("non-gated writes incur no relation read (early-out) + lock discipline", () => {
  it("a transition into a NON-gated state succeeds with NO relation store present", async () => {
    const root = await makeGatedRoot(gatedProfile(1));
    try {
      await writeMarkdownPage(root, "wiki/experiments", "ng", expBody("designed"));
      await transitionLifecycle(root, "experiments", "ng", "running"); // `running` is not gated
      expect(await readFile(path.join(root, "wiki/experiments", "ng.md"), "utf8")).toContain("stage: running");
      expect(existsSync(path.join(root, RELATIONS_FILE))).toBe(false); // no store read/created
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("the enforcer acquires NO lock (structural guarantee — safe inside the held lock)", async () => {
    const files = [
      "../src/relations/enforce-precondition.ts",
      "../src/profile/lifecycle-read.ts", // the resolver's evidence read path
      "../src/utils/confined-read.ts", // the handle-bound page reader beneath it
    ];
    const src = (await Promise.all(files.map((f) => readFile(new URL(f, import.meta.url), "utf8")))).join("\n");
    // Match INVOCATIONS (identifier immediately followed by `(`), so the LOCK-FREE
    // prose in the doc comment is not a false positive — only a real call fails this.
    expect(src).not.toMatch(/\b(acquireLock|acquireLockBlocking|underLock)\s*\(/);
  });
});

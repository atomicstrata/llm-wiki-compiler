/**
 * @file test/relation-lifecycle-executor-kinds.test.ts
 * @description Type-foundation tests for the discriminated {@link PlannedMutation}
 * union: a `page` mutation carries a body; `relation`/`lifecycle-transition`
 * mutations carry intent only (no body). Also pins the stable
 * {@link CrossStoreBatchUnsupportedError} message contract.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  PagePlannedMutation,
  RelationPlannedMutation,
  LifecycleTransitionPlannedMutation,
  PlannedMutation,
} from "../src/trust/planner.js";
import { planPageMutation } from "../src/trust/planner.js";
import { applyApprovedMutations } from "../src/trust/executor.js";
import type { ApplyResult } from "../src/trust/apply-result.js";
import { CrossStoreBatchUnsupportedError } from "../src/trust/apply-result.js";
import { makeTrustRoot, cleanupTrustRoot } from "./trust/fixture.js";
import {
  createRelation,
  createRelationForProject,
  RelationWriteDeniedError,
} from "../src/trust/relation-write.js";
import { loadNonDefaultProfile } from "../src/profile/block.js";
import { readRelations } from "../src/relations/store-read.js";
import { readEvents } from "../src/events/store-read.js";
import { PROFILE_FILE, LOCK_FILE } from "../src/utils/constants.js";
import { buildResearchLiteProject } from "./fixtures/profile-fixtures.js";
import { expectLifecycleEventDecision, buildPapersLifecycleProject } from "./fixtures/seam-fixtures.js";
import {
  transitionLifecycle,
  LifecycleTransitionLockError,
} from "../src/trust/lifecycle-transition.js";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { LockBusyError, acquireLock, releaseLock } from "../src/utils/lock.js";
import { applyRelationLocked } from "../src/trust/relation-apply.js";
import { applyLifecycleLocked } from "../src/trust/lifecycle-apply.js";
import type { EntityId, ProfilePack } from "../src/profile/types.js";

/**
 * A research-lite profile carrying a `cites` relation (papers→papers). Mirrors
 * the relation-write fixtures, but with both endpoints in `papers` so the seam
 * tests can vary only the relation under test.
 */
function citesProfile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research-cites",
    entities: { papers: { directory: "wiki/papers" } },
    relations: { cites: { from: ["papers"], to: ["papers"], direction: "directed" } },
  } as ProfilePack;
}

/** Build a non-default `cites` relation project; returns its root. */
async function makeRelationRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rel-seam-"));
  await buildResearchLiteProject(root);
  await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(citesProfile()), "utf8");
  return root;
}

/** Load the on-disk non-default profile (the under-lock authority's source). */
async function loadProfileForTest(root: string): Promise<ProfilePack> {
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) throw new Error("expected a non-default profile");
  return loaded.profile;
}

/** Read the persisted relation store (records + problems). */
function readRelationsForTest(root: string): ReturnType<typeof readRelations> {
  return readRelations(root);
}

/** Read the append-only audit events (in file order). */
async function readEventsForTest(root: string): Promise<{ decision?: string }[]> {
  return (await readEvents(root)).events;
}

/** A papers→papers relation input of the given type (the shared endpoint pair). */
function papersInput(type: string): { type: string; from: EntityId; to: EntityId; attributes: object } {
  return { type, from: "papers/a" as EntityId, to: "papers/b" as EntityId, attributes: {} };
}

/** Assert a relation write rejected as denied AND left the store empty. */
async function expectDeniedNothingAppended(root: string, write: Promise<unknown>): Promise<void> {
  await expect(write).rejects.toBeInstanceOf(RelationWriteDeniedError);
  expect((await readRelationsForTest(root)).relations.length).toBe(0);
}

describe("discriminated PlannedMutation union", () => {
  it("page mutation carries a body; relation/lifecycle carry intent only", () => {
    const page: PagePlannedMutation = {
      kind: "page",
      operation: "create",
      target: { directory: "concepts", slug: "x" },
      body: "---\ntitle: X\n---\n",
      provenance: { origin: "compile", decision: "allow", reviewRouted: false },
    };
    const rel: RelationPlannedMutation = {
      kind: "relation",
      operation: "create",
      input: { type: "cites", from: "papers/a", to: "papers/b", attributes: {} } as any,
    };
    const life: LifecycleTransitionPlannedMutation = {
      kind: "lifecycle-transition",
      entityType: "papers",
      slug: "a",
      toState: "published",
    };
    expect(page.body).toBeTypeOf("string");
    // @ts-expect-error — relation has no body
    void rel.body;
    // @ts-expect-error — lifecycle has no body
    void life.body;
  });

  it("ApplyResult discriminates: page yields no value; relation/lifecycle carry the composed decision (relation also a ref)", () => {
    const page: ApplyResult = { kind: "page" };
    const life: ApplyResult = { kind: "lifecycle-transition", decision: "allow-with-warning" };
    expect(page.kind).toBe("page");
    expect(life.kind).toBe("lifecycle-transition");
    if (life.kind === "lifecycle-transition") expect(life.decision).toBe("allow-with-warning");
    // @ts-expect-error — a relation ApplyResult must carry both the persisted ref AND the decision
    const rel: ApplyResult = { kind: "relation" };
    void rel;
    // @ts-expect-error — a lifecycle ApplyResult must carry the composed decision
    const lifeMissing: ApplyResult = { kind: "lifecycle-transition" };
    void lifeMissing;
  });

  it("CrossStoreBatchUnsupportedError is a typed error with the stable message prefix", () => {
    const e = new CrossStoreBatchUnsupportedError("mixed");
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toMatch(/^cross-store-batch-unsupported:/);
  });
});

describe("executor dispatcher shape guard", () => {
  let root: string;
  const GOOD_BODY = "---\ntitle: Ok\n---\n\nbody\n";

  beforeEach(async () => {
    root = await makeTrustRoot("dispatcher-shape-");
  });
  afterEach(async () => {
    await cleanupTrustRoot(root);
  });

  /** A valid, allowed page-create PlannedMutation targeting `wiki/concepts/<slug>.md`. */
  async function pageFor(slug: string): Promise<PagePlannedMutation> {
    const out = await planPageMutation({
      root,
      target: { kind: "entity", entityType: "concepts", slug },
      body: GOOD_BODY,
      origin: "agent",
      reviewRouted: false,
    });
    return out.planned[0];
  }

  /** An intent-only relation mutation (the dispatcher never reaches its handler here). */
  function relationMutation(): RelationPlannedMutation {
    return {
      kind: "relation",
      operation: "create",
      input: { type: "cites", from: "papers/a", to: "papers/b", attributes: {} } as never,
    };
  }

  it("rejects a mixed page+relation batch as cross-store-batch-unsupported", async () => {
    const batch: PlannedMutation[] = [await pageFor("a"), relationMutation()];
    await expect(applyApprovedMutations(root, batch)).rejects.toThrow(/^cross-store-batch-unsupported:/);
  });

  it("rejects a multi-relation batch with CrossStoreBatchUnsupportedError", async () => {
    const batch: PlannedMutation[] = [relationMutation(), relationMutation()];
    await expect(applyApprovedMutations(root, batch)).rejects.toBeInstanceOf(CrossStoreBatchUnsupportedError);
  });

  it("resolves a homogeneous page batch to an array of page ApplyResults", async () => {
    const batch: PlannedMutation[] = [await pageFor("one"), await pageFor("two")];
    const results: ApplyResult[] = await applyApprovedMutations(root, batch);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.kind === "page")).toBe(true);
  });

  // A lone workflow mutation passes the batch-shape guard (single kind) but has
  // no handler — it must hit the executor's not-implemented fall-through. `artifact`
  // now has its own handler (see test/artifacts/artifact-apply.test.ts) and is no
  // longer in this list. No constructor exists for these kinds yet, so build
  // minimal `as any` shapes.
  it.each(["workflow-state", "workflow-gate"])(
    "a lone %s mutation hits the not-implemented executor fall-through",
    async (kind) => {
      const batch = [{ kind } as never] as PlannedMutation[];
      await expect(applyApprovedMutations(root, batch)).rejects.toThrow(/not-implemented/);
    },
  );
});

describe("relation kind through the seam", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("createRelation returns the RelationRef carried back through the executor", async () => {
    root = await makeRelationRoot();
    const ref = await createRelationForProject(root, papersInput("cites"));
    expect(ref.id).toMatch(/^rel_/);
    expect(ref.type).toBe("cites");
  });

  it("a denied relation (undeclared type) fails closed with RelationWriteDeniedError; nothing appended", async () => {
    root = await makeRelationRoot();
    await expectDeniedNothingAppended(root, createRelationForProject(root, papersInput("nope")));
  });

  it("the handler uses the ON-DISK profile under the lock, NOT a caller-supplied one (stale/fake-profile probe)", async () => {
    root = await makeRelationRoot();
    const onDisk = await loadProfileForTest(root);
    const permissive = {
      ...onDisk,
      relations: { ...(onDisk.relations ?? {}), forbidden: onDisk.relations!.cites },
    } as ProfilePack;
    // on-disk profile does NOT declare 'forbidden' — the under-lock authority denies it.
    await expectDeniedNothingAppended(root, createRelation(root, permissive, papersInput("forbidden")));
  });

  it("a successful relation create records the recomposed decision as a TOP-LEVEL event field", async () => {
    root = await makeRelationRoot();
    await createRelationForProject(root, papersInput("cites"));
    expect((await readEventsForTest(root)).at(-1)?.decision).toBe("allow");
  });

  // FIX 5: the under-lock authority threads the COMPOSED decision back alongside
  // the ref (not a hardcoded literal), so the seam records the real decision.
  it("applyRelationLocked returns the composed decision alongside the persisted ref", async () => {
    root = await makeRelationRoot();
    expect(await acquireLock(root, { quiet: true })).toBe(true);
    try {
      const out = await applyRelationLocked(root, { kind: "relation", operation: "create", input: papersInput("cites") });
      expect(out.ref.id).toMatch(/^rel_/);
      expect(out.decision).toBe("allow");
    } finally {
      await releaseLock(root);
    }
  });

  it("concurrent createRelation calls all succeed (bounded-blocking serialization preserved)", async () => {
    root = await makeRelationRoot();
    const inputs = Array.from({ length: 5 }, (_, i) => ({
      type: "cites", from: `papers/a${i}` as EntityId, to: `papers/b${i}` as EntityId, attributes: {},
    }));
    const refs = await Promise.all(inputs.map((inp) => createRelationForProject(root, inp)));
    expect(new Set(refs.map((r) => r.id)).size).toBe(5); // all distinct, none threw
  });
});

/**
 * A profile whose `papers` entity carries a `draft → review → published`
 * lifecycle FSM on a `lifecycle` enum field. Mirrors the SDK lifecycle fixture
 * but keeps the FSM minimal so the seam tests vary only the transition.
 */
function lifecycleProfile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research-lifecycle",
    entities: {
      papers: {
        directory: "wiki/papers",
        requiredFields: ["lifecycle"],
        fields: {
          lifecycle: { type: "enum", enum: ["draft", "review", "published"] },
        },
        lifecycle: {
          field: "lifecycle",
          initial: "draft",
          terminal: ["published"],
          transitions: { draft: ["review"], review: ["published"] },
        },
      },
    },
  } as ProfilePack;
}

/** Build a lifecycle project with a `papers/a` page already in `draft`. */
async function makeLifecycleRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lc-seam-"));
  await buildPapersLifecycleProject(root, lifecycleProfile());
  return root;
}

/** Read a page's parsed frontmatter (the lifecycle field lives here). */
async function readPageMeta(root: string, entityType: string, slug: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path.join(root, "wiki", entityType, `${slug}.md`), "utf8");
  return parseFrontmatter(raw).meta;
}

describe("lifecycle kind through the seam", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("valid transition writes the page, decision allow, and the event carries a TOP-LEVEL decision", async () => {
    root = await makeLifecycleRoot();
    await transitionLifecycle(root, "papers", "a", "review"); // legal draft->review
    expect((await readPageMeta(root, "papers", "a")).lifecycle).toBe("review");
    await expectLifecycleEventDecision(root, "allow"); // TOP-LEVEL, like relation events
  });

  // FIX 5: the lifecycle authority returns the COMPOSED decision so the seam
  // records the real one rather than a hardcoded literal.
  it("applyLifecycleLocked returns the composed decision", async () => {
    root = await makeLifecycleRoot();
    expect(await acquireLock(root, { quiet: true })).toBe(true);
    try {
      const decision = await applyLifecycleLocked(root, { kind: "lifecycle-transition", entityType: "papers", slug: "a", toState: "review" });
      expect(decision).toBe("allow");
    } finally {
      await releaseLock(root);
    }
  });

  it("a lock-contended transition throws the typed LifecycleTransitionLockError", async () => {
    root = await makeLifecycleRoot();
    await writeFile(path.join(root, LOCK_FILE), String(process.pid), "utf8");
    await expect(transitionLifecycle(root, "papers", "a", "review")).rejects.toBeInstanceOf(
      LifecycleTransitionLockError,
    );
  });

  // The lifecycle lock error is unified under the shared LockBusyError supertype, so
  // an SDK caller batching store ops can catch ALL lock contention with one type —
  // while the precise subtype + its message stay unchanged for existing matchers.
  it("a lock-contended transition is also catchable as the shared LockBusyError", async () => {
    root = await makeLifecycleRoot();
    await writeFile(path.join(root, LOCK_FILE), String(process.pid), "utf8");
    const err = await transitionLifecycle(root, "papers", "a", "review").catch((e) => e);
    expect(err).toBeInstanceOf(LockBusyError);
    expect(err).toBeInstanceOf(LifecycleTransitionLockError);
    expect((err as Error).name).toBe("LifecycleTransitionLockError");
    expect((err as Error).message).toContain("another llmwiki process is using this project");
  });

  it("an illegal transition denies and leaves the page unchanged", async () => {
    root = await makeLifecycleRoot();
    await expect(transitionLifecycle(root, "papers", "a", "published")).rejects.toBeTruthy();
    expect((await readPageMeta(root, "papers", "a")).lifecycle).toBe("draft");
  });

  it("the lifecycle handler does NOT call applyTypedCandidate or re-enter the executor (strip comments first)", async () => {
    const raw = await readFile(new URL("../src/trust/lifecycle-apply.ts", import.meta.url), "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/applyTypedCandidate\s*\(/);
    expect(code).not.toMatch(/applyApprovedMutationsLocked\s*\(/);
  });
});

describe("public write surfaces route through the locked executor core", () => {
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it("public write surfaces route through the LOCKED executor core, not bespoke helpers or the fail-fast wrapper", async () => {
    const rel = stripComments(await readFile(new URL("../src/trust/relation-write.ts", import.meta.url), "utf8"));
    const life = stripComments(await readFile(new URL("../src/trust/lifecycle-transition.ts", import.meta.url), "utf8"));
    expect(rel).toMatch(/applyApprovedMutationsLocked\s*\(/);
    expect(life).toMatch(/applyApprovedMutationsLocked\s*\(/);
    // must NOT use the fail-fast self-locking wrapper (note: `applyApprovedMutations(` does NOT match `applyApprovedMutationsLocked(`)
    expect(rel).not.toMatch(/applyApprovedMutations\s*\(/);
    expect(life).not.toMatch(/applyApprovedMutations\s*\(/);
    // the seam/handlers own the underlying writes now
    expect(rel).not.toMatch(/appendRelationLocked\s*\(/);
    expect(life).not.toMatch(/applyTypedCandidate\s*\(/);
  });
});

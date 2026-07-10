/**
 * @file test/trust-planner.test.ts
 * @description Coverage for the WRITE PLANNER (`src/trust/planner.ts`) and the
 * guarded page EXECUTOR (`src/trust/executor.ts`) — the seam that realizes CLP
 * Invariant 4 (every mutation passes through ONE planner) and the PAGE-store
 * atomicity contract ("partial application is a bug").
 *
 * Planner tests pin the decision→plan mapping: an allowed, confined, well-formed
 * page yields exactly one `create` PlannedMutation; any block-derived decision
 * yields NO live-write mutation (the decision carries the routing instead).
 *
 * Executor tests prove ATOMICITY by fault injection: a clean 2-mutation batch
 * applies BOTH and commits; a 2-mutation batch whose SECOND write is forced to
 * throw (via the injectable `writeOne` seam) leaves, after the failure plus
 * `replayJournal`, the FULL PRE-STATE — file 1 reverted, file 2 absent — never a
 * partial post-state where file 1 persisted and file 2 is missing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile } from "fs/promises";
import path from "path";
import {
  planPageMutation,
  type PlannedMutation,
} from "../src/trust/planner.js";
import { applyApprovedMutations } from "../src/trust/executor.js";
import { replayJournal, openBatch, recordPreState } from "../src/trust/journal.js";
import { entityId } from "../src/profile/identity.js";
import { COMPILE_ORIGIN } from "../src/trust/checks.js";
import { MAX_SOURCE_CHARS, GENERATED_PAGE_MAX_CHARS } from "../src/utils/constants.js";
import {
  WIKI,
  makeTrustRoot,
  cleanupTrustRoot,
  expectRevertedToPreState,
  existsUnder,
  failingWriteOneOnNth,
} from "./trust/fixture.js";

let root: string;
const GOOD_BODY = "---\ntitle: Ok\n---\n\nbody\n";

beforeEach(async () => {
  root = await makeTrustRoot("trust-planner-");
});

afterEach(async () => {
  await cleanupTrustRoot(root);
});

function planArgs(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    root,
    target: { kind: "entity" as const, entityType: "concepts", slug },
    body: GOOD_BODY,
    origin: "agent",
    reviewRouted: false,
    ...overrides,
  };
}

describe("planPageMutation — decision→plan mapping", () => {
  it("plans exactly one create for a confined, well-formed, non-colliding page", async () => {
    const out = await planPageMutation(planArgs("alpha"));
    expect(out.decision).toBe("allow");
    expect(out.planned).toHaveLength(1);
    expect(out.planned[0].kind).toBe("page");
    expect(out.planned[0].operation).toBe("create");
  });

  it("denies an escaping slug with no planned mutation", async () => {
    const out = await planPageMutation(planArgs("../escape"));
    expect(out.decision).toBe("deny");
    expect(out.planned).toEqual([]);
  });

  it("yields a block-derived decision and no plan for an existing target", async () => {
    await writeFile(path.join(root, WIKI, "dup.md"), GOOD_BODY);
    const out = await planPageMutation(planArgs("dup"));
    expect(out.decision).toBe("deny"); // block + non-review-routed ⇒ deny
    expect(out.planned).toEqual([]);
  });

  it("stages a block for review when reviewRouted is true", async () => {
    await writeFile(path.join(root, WIKI, "dup.md"), GOOD_BODY);
    const out = await planPageMutation(planArgs("dup", { reviewRouted: true }));
    expect(out.decision).toBe("stage-for-review");
    expect(out.planned).toEqual([]);
  });
});

describe("planPageMutation — create vs update intent", () => {
  it("plans a create for a free target regardless of allowOverwrite", async () => {
    const out = await planPageMutation(planArgs("free", { allowOverwrite: true }));
    expect(out.decision).toBe("allow");
    expect(out.planned).toHaveLength(1);
    expect(out.planned[0].operation).toBe("create");
  });

  it("plans an update (decision allow) for an existing target when allowOverwrite", async () => {
    await writeFile(path.join(root, WIKI, "exists.md"), GOOD_BODY);
    const out = await planPageMutation(planArgs("exists", { allowOverwrite: true }));
    expect(out.decision).toBe("allow");
    expect(out.planned).toHaveLength(1);
    expect(out.planned[0].operation).toBe("update");
  });

  it("blocks (no live mutation) for an existing target when allowOverwrite is false", async () => {
    await writeFile(path.join(root, WIKI, "exists.md"), GOOD_BODY);
    const out = await planPageMutation(planArgs("exists", { allowOverwrite: false }));
    expect(out.decision).toBe("deny");
    expect(out.planned).toEqual([]);
  });
});

/** Build a page-create PlannedMutation targeting `<WIKI>/<slug>.md`. */
async function plannedFor(slug: string): Promise<PlannedMutation> {
  const out = await planPageMutation(planArgs(slug));
  return out.planned[0];
}

describe("applyApprovedMutations — clean batch", () => {
  it("applies BOTH mutations and commits", async () => {
    const planned = [await plannedFor("one"), await plannedFor("two")];
    await applyApprovedMutations(root, planned);
    expect(await readFile(path.join(root, WIKI, "one.md"), "utf-8")).toBe(GOOD_BODY);
    expect(await readFile(path.join(root, WIKI, "two.md"), "utf-8")).toBe(GOOD_BODY);
  });

  it("routes a lone lifecycle-transition to its under-lock authority (fails closed without a profile)", async () => {
    // `relation` and `lifecycle-transition` now BOTH route to their handlers
    // (Task 4). On this profile-less default root the lifecycle authority fails
    // CLOSED — it never reaches `not-implemented` (only artifact/workflow do).
    const lifecycle: PlannedMutation = {
      kind: "lifecycle-transition", entityType: "concepts", slug: "p", toState: "done",
    };
    await expect(applyApprovedMutations(root, [lifecycle])).rejects.toThrow(/cannot transition lifecycle/);
  });
});

describe("applyApprovedMutations — create-collision re-probe under lock", () => {
  it("aborts and does NOT clobber a target created after planning", async () => {
    // Plan a create while the target is free (collision check passes here).
    const create = await plannedFor("late");
    // A concurrent actor creates the target AFTER planning, BEFORE apply.
    const target = path.join(root, WIKI, "late.md");
    await writeFile(target, "CONCURRENT");

    // Apply must re-probe under the lock and abort before any write lands.
    await expect(applyApprovedMutations(root, [create])).rejects.toThrow(/create-collision/);

    // The pre-existing file is untouched — never overwritten by the create.
    expect(await readFile(target, "utf-8")).toBe("CONCURRENT");
  });
});

/** Hand-build an `update` mutation targeting `<WIKI>/<slug>.md` with `body`. */
function updateMutation(slug: string, body: string): PlannedMutation {
  return {
    kind: "page",
    operation: "update",
    target: { entityType: "concepts", slug, id: entityId("concepts", slug) },
    body,
    provenance: {
      origin: "agent",
      decision: "allow",
      reviewRouted: false,
    },
  };
}

describe("applyApprovedMutations — update overwrites an existing target", () => {
  it("overwrites without a create-collision error", async () => {
    const target = path.join(root, WIKI, "exists.md");
    await writeFile(target, "OLD");
    const update = updateMutation("exists", GOOD_BODY);
    await applyApprovedMutations(root, [update]);
    expect(await readFile(target, "utf-8")).toBe(GOOD_BODY);
  });
});

/**
 * Assert the executor's S5 floor REFUSES a hand-built update (typed
 * `mutation-floor` throw) and writes NOTHING. `origin` defaults to the
 * `updateMutation` default (`agent`); pass `"compile"` to test the larger cap.
 */
async function expectFloorRefusal(slug: string, body: string, origin?: string): Promise<void> {
  const update = updateMutation(slug, body);
  if (origin) update.provenance.origin = origin;
  await expect(applyApprovedMutations(root, [update])).rejects.toThrow(/mutation-floor/);
  expect(await existsUnder(root, `${WIKI}/${slug}.md`)).toBe(false);
}

describe("applyApprovedMutations — S5 full-floor re-assertion", () => {
  it("refuses an OVERSIZED body with MutationFloorError and writes nothing", async () => {
    await expectFloorRefusal("big", "x".repeat(MAX_SOURCE_CHARS + 1));
  });

  it("refuses MALFORMED frontmatter with MutationFloorError and writes nothing", async () => {
    await expectFloorRefusal("malformed", "---\ntitle: : : bad\n  nope\n---\n\nbody\n");
  });
});

describe("planPageMutation — origin-derived resource cap", () => {
  const BETWEEN = "x".repeat(MAX_SOURCE_CHARS + 50_000);

  it("BLOCKS a non-compile body between the single-source and generated caps", async () => {
    expect(BETWEEN.length).toBeGreaterThan(MAX_SOURCE_CHARS);
    expect(BETWEEN.length).toBeLessThan(GENERATED_PAGE_MAX_CHARS);
    const out = await planPageMutation(planArgs("between", { origin: "agent", body: BETWEEN }));
    expect(out.decision).toBe("deny"); // single-source cap ⇒ resource-limit block
    expect(out.planned).toEqual([]);
  });

  it("ALLOWS a compile body in the same between-caps range (the larger cap applies)", async () => {
    const out = await planPageMutation(planArgs("between", { origin: COMPILE_ORIGIN, body: BETWEEN }));
    expect(out.decision).toBe("allow");
    expect(out.planned).toHaveLength(1);
  });
});

describe("applyApprovedMutations — plan-time and apply-time agree on the cap", () => {
  it("a compile mutation between the caps passes S5 re-assertion and writes", async () => {
    const between = "x".repeat(MAX_SOURCE_CHARS + 50_000);
    const update = updateMutation("merged", between);
    update.provenance.origin = COMPILE_ORIGIN; // executor derives the SAME larger cap
    await applyApprovedMutations(root, [update]);
    expect(await readFile(path.join(root, WIKI, "merged.md"), "utf-8")).toBe(between);
  });

  it("a NON-compile mutation between the caps is refused by S5 (single-source cap)", async () => {
    await expectFloorRefusal("merged-agent", "x".repeat(MAX_SOURCE_CHARS + 50_000));
  });
});

describe("applyApprovedMutations — atomicity under fault injection", () => {
  it("reverts to FULL pre-state when the second write throws", async () => {
    const t1 = `${WIKI}/exists.md`; // pre-existing → must revert to prior bytes
    const t2 = `${WIKI}/fresh.md`; //  absent pre-batch → must stay absent
    await writeFile(path.join(root, t1), "OLD-1");

    // Plan an UPDATE of t1 and a CREATE of t2 by hand-building mutations so the
    // pre-existing t1 does not trip the create-only collision check.
    const create2 = await plannedFor("fresh");
    const update1: PlannedMutation = {
      ...create2,
      operation: "update",
      target: { entityType: "concepts", slug: "exists", id: entityId("concepts", "exists") },
    };

    // Fault seam: a writeOne hook that throws on the SECOND target only.
    const faultyWriteOne = failingWriteOneOnNth(2);

    await expect(
      applyApprovedMutations(root, [update1, create2], { writeOne: faultyWriteOne }),
    ).rejects.toThrow(/injected write failure/);

    await replayJournal(root);

    await expectRevertedToPreState(root, t1, "OLD-1", t2);
  });
});

describe("applyApprovedMutations — self-enforcing replay on startup", () => {
  it("reverts a dangling pending batch from a prior crash before the new batch", async () => {
    // Simulate a prior crash: open a pending batch, record a target's pre-state,
    // then "write" a post-state without committing — exactly a dangling journal.
    const danglingRel = `${WIKI}/crashed.md`;
    const danglingAbs = path.join(root, danglingRel);
    await writeFile(danglingAbs, "PRE-CRASH");
    const stale = await openBatch(root);
    await recordPreState(stale, danglingAbs);
    await writeFile(danglingAbs, "MID-CRASH-POST-STATE"); // uncommitted post-state

    // A fresh, UNRELATED clean batch must trigger replay under the lock first.
    const clean = await plannedFor("unrelated");
    await applyApprovedMutations(root, [clean]);

    // Replay ran: the dangling target was reverted to its pre-crash bytes...
    expect(await readFile(danglingAbs, "utf-8")).toBe("PRE-CRASH");
    // ...and the new batch applied and committed normally.
    expect(await readFile(path.join(root, WIKI, "unrelated.md"), "utf-8")).toBe(GOOD_BODY);
  });
});

describe("applyApprovedMutations — executor re-asserts slug safety", () => {
  it("throws invalid-identity and writes nothing for a hand-built `..` slug", async () => {
    const base = await plannedFor("safe");
    // Hand-built mutation whose id carries a traversal slug — bypasses the
    // planner's checkIdentitySafe guard, so the executor must re-validate.
    const evil: PlannedMutation = {
      ...base,
      target: { entityType: "concepts", slug: "../escape", id: "concepts/../escape" as never },
    };
    await expect(applyApprovedMutations(root, [evil])).rejects.toThrow(/invalid-identity/);
    // Nothing escaped the root: no file was created outside wiki/concepts.
    expect(await existsUnder(root, "escape.md")).toBe(false);
    expect(await existsUnder(root, "wiki/escape.md")).toBe(false);
  });
});

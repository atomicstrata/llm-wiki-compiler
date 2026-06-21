/**
 * @file test/trust-planner-default.test.ts
 * @description Coverage for the DEFAULT raw-page mutation path
 * (`planDefaultPageMutation` in `src/trust/planner.ts`) plus its executor
 * round-trip. Default wiki pages carry Unicode `slugify` slugs (e.g.
 * `café-society`, `机器学习`) and, per the Phase-1 invariant, NEVER become
 * EntityIds — so this path uses a {@link RawPageRef} (raw stem, no typed id)
 * and the {@link isSafeFilenameComponent} identity floor rather than the
 * slug-safe EntityId grammar.
 *
 * The suite pins: a Unicode slug on a free target plans+writes a `create`
 * with a RawPageRef; an existing target upserts (`update`) or blocks by
 * `allowOverwrite`; a traversal/separator/dot/leading-dot slug is blocked at
 * plan time AND re-rejected by the executor for a hand-built RawPageRef.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile } from "fs/promises";
import path from "path";
import {
  planDefaultPageMutation,
  type PlannedMutation,
  type RawPageRef,
} from "../src/trust/planner.js";
import { applyApprovedMutations, applyApprovedMutationsLocked } from "../src/trust/executor.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { makeTrustRoot, cleanupTrustRoot, existsUnder } from "./trust/fixture.js";

let root: string;
const GOOD_BODY = "---\ntitle: Ok\n---\n\nbody\n";
const UNICODE_SLUG = "café-society";

beforeEach(async () => {
  root = await makeTrustRoot("trust-planner-default-");
});

afterEach(async () => {
  await cleanupTrustRoot(root);
});

function defaultArgs(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    root,
    directory: "concepts",
    slug,
    body: GOOD_BODY,
    origin: "agent",
    reviewRouted: false,
    ...overrides,
  };
}

describe("planDefaultPageMutation — Unicode slug, free target", () => {
  it("allows and plans one create with a RawPageRef (no id)", async () => {
    const out = await planDefaultPageMutation(defaultArgs(UNICODE_SLUG));
    expect(out.decision).toBe("allow");
    expect(out.planned).toHaveLength(1);
    const target = out.planned[0].target as RawPageRef;
    expect(target).toEqual({ directory: "concepts", slug: UNICODE_SLUG });
    expect("id" in target).toBe(false);
    expect(out.planned[0].operation).toBe("create");
  });

  it("executor writes wiki/concepts/<unicode>.md with the body", async () => {
    const out = await planDefaultPageMutation(defaultArgs(UNICODE_SLUG));
    await applyApprovedMutations(root, out.planned);
    const written = path.join(root, "wiki", "concepts", `${UNICODE_SLUG}.md`);
    expect(await readFile(written, "utf-8")).toBe(GOOD_BODY);
  });
});

describe("planDefaultPageMutation — existing target", () => {
  it("plans an update overwriting when allowOverwrite is true", async () => {
    const target = path.join(root, "wiki", "concepts", `${UNICODE_SLUG}.md`);
    await writeFile(target, "OLD");
    const out = await planDefaultPageMutation(defaultArgs(UNICODE_SLUG, { allowOverwrite: true }));
    expect(out.decision).toBe("allow");
    expect(out.planned[0].operation).toBe("update");
    await applyApprovedMutations(root, out.planned);
    expect(await readFile(target, "utf-8")).toBe(GOOD_BODY);
  });

  it("blocks (no live mutation) when allowOverwrite is false", async () => {
    const target = path.join(root, "wiki", "concepts", `${UNICODE_SLUG}.md`);
    await writeFile(target, "OLD");
    const out = await planDefaultPageMutation(defaultArgs(UNICODE_SLUG, { allowOverwrite: false }));
    expect(out.decision).toBe("deny");
    expect(out.planned).toEqual([]);
    expect(await readFile(target, "utf-8")).toBe("OLD");
  });
});

describe("planDefaultPageMutation — unsafe filename components are blocked", () => {
  const unsafe = ["../escape", "a/b", "a\\b", "with\0nul", ".", "..", ".hidden", ""];
  for (const slug of unsafe) {
    it(`blocks slug ${JSON.stringify(slug)} with no live mutation`, async () => {
      const out = await planDefaultPageMutation(defaultArgs(slug));
      expect(out.planned).toEqual([]);
      expect(out.decision).not.toBe("allow");
    });
  }

  it("blocks an unsafe directory component", async () => {
    const out = await planDefaultPageMutation(defaultArgs(UNICODE_SLUG, { directory: "../evil" }));
    expect(out.planned).toEqual([]);
  });
});

describe("applyApprovedMutationsLocked — lock-free core for an outer locked region", () => {
  it("writes the page when the CALLER already holds the lock (no nested acquire)", async () => {
    const out = await planDefaultPageMutation(defaultArgs(UNICODE_SLUG));
    expect(await acquireLock(root)).toBe(true); // simulate the held review lock
    try {
      await applyApprovedMutationsLocked(root, out.planned);
    } finally {
      await releaseLock(root);
    }
    const target = path.join(root, "wiki", "concepts", `${UNICODE_SLUG}.md`);
    expect(await readFile(target, "utf-8")).toBe(GOOD_BODY);
  });
});

describe("executor re-asserts the default-page identity floor", () => {
  it("throws invalid-identity for a hand-built RawPageRef with a `..` slug", async () => {
    const evil: PlannedMutation = {
      kind: "page",
      operation: "create",
      target: { directory: "concepts", slug: "../escape" } as RawPageRef,
      body: GOOD_BODY,
      provenance: { origin: "agent", decision: "allow", reviewRouted: false },
    };
    await expect(applyApprovedMutations(root, [evil])).rejects.toThrow(/invalid-identity/);
    expect(await existsUnder(root, "wiki/escape.md")).toBe(false);
  });
});

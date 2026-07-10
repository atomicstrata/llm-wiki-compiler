/**
 * @file test/search-fallback-eligibility.test.ts
 * @description PR4F — the embeddings-unavailable fallback selects over LIVE,
 * surface-eligible, pageId-keyed candidates (NOT the rendered index.md).
 *
 * Covers the two HIGH findings:
 *  - Finding 3 (PRIVACY): a typed page whose type opts OUT of a surface
 *    (`includeInSearch:false`, or BOTH flags false) is NEVER enumerated, NEVER
 *    rendered into the selector prompt, and is DROPPED even if a stubbed LLM
 *    returns its pageId.
 *  - Finding 1 (NAMESPACE): a saved-query / typed / concept pick resolves to its
 *    real namespace (`queries|<type>|concepts`), never collapsed to `concepts/*`.
 *
 * Strategy: write NO embeddings.json (forces the fallback), stub `selectPages`'s
 * underlying `callClaude` to echo chosen pageId tokens, and inspect both the
 * enumerated candidates and the rendered prompt the selector sees.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import { mkdir, writeFile } from "fs/promises";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { writeProfileFile } from "./fixtures/profile-fixtures.js";
import { stubSelectPages } from "./fixtures/fallback-stub.js";
import type { ProfilePack } from "../src/profile/types.js";

vi.mock("../src/utils/llm.js", () => ({ callClaude: vi.fn() }));

/** A mixed profile: `papers` opts out of search; `secrets` opts out of both. */
const MIXED_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "mixed",
  entities: {
    notes: { directory: "wiki/notes", retrieval: { includeInSearch: true, includeInContext: true } },
    papers: { directory: "wiki/papers", retrieval: { includeInSearch: false, includeInContext: true } },
    secrets: { directory: "wiki/secrets", retrieval: { includeInSearch: false, includeInContext: false } },
  },
};

/** Seed a mixed project (NO embeddings.json) with one page per typed type + a concept + a query. */
async function seedMixed(): Promise<string> {
  const root = await makeTempRoot("f-mixed");
  await writeFile(path.join(root, "wiki", "index.md"), "# Index\n");
  await writeProfileFile(root, MIXED_PROFILE);
  await writePage(path.join(root, "wiki/concepts"), "c-one", { title: "Concept One", summary: "cs" }, "Concept body.");
  await writePage(path.join(root, "wiki/queries"), "q-one", { title: "Query One", summary: "qs" }, "Query body.");
  for (const [dir, slug, title] of [["notes", "n-one", "Note One"], ["papers", "p-one", "Paper One"], ["secrets", "s-one", "Secret One"]]) {
    await mkdir(path.join(root, "wiki", dir), { recursive: true });
    await writePage(path.join(root, "wiki", dir), slug, { title, summary: `${slug}-sum` }, `${title} body.`);
  }
  return root;
}

describe("buildSurfaceEligibleCandidates — privacy + surface specificity (Finding 3)", () => {
  let buildSurfaceEligibleCandidates: typeof import("../src/utils/page-registry.js").buildSurfaceEligibleCandidates;
  let buildNamespaceDirs: typeof import("../src/utils/page-registry.js").buildNamespaceDirs;
  let loadProfile: typeof import("../src/profile/load.js").loadProfile;

  beforeEach(async () => {
    vi.resetModules();
    ({ buildSurfaceEligibleCandidates, buildNamespaceDirs } = await import("../src/utils/page-registry.js"));
    ({ loadProfile } = await import("../src/profile/load.js"));
  });
  afterEach(() => vi.restoreAllMocks());

  /** Enumerate candidate pageIds for `surface` over the mixed project. */
  async function enumerate(root: string, surface: "search" | "context"): Promise<string[]> {
    const profile = await loadProfile(root);
    const namespaces = ["concepts", "queries", ...Object.keys(profile.profile.entities)];
    const dirs = buildNamespaceDirs(profile.profile);
    const candidates = await buildSurfaceEligibleCandidates(root, surface, namespaces, dirs, profile);
    return candidates.map((c) => c.pageId);
  }

  it("an includeInSearch:false typed page is NEVER in the search candidate set", async () => {
    const ids = await enumerate(await seedMixed(), "search");
    expect(ids).not.toContain("papers/p-one");
  });

  it("a both-false typed page is in NEITHER surface's candidate set", async () => {
    const root = await seedMixed();
    expect(await enumerate(root, "search")).not.toContain("secrets/s-one");
    expect(await enumerate(root, "context")).not.toContain("secrets/s-one");
  });

  it("an includeInSearch:false,includeInContext:true page appears under context but NOT search", async () => {
    const root = await seedMixed();
    expect(await enumerate(root, "context")).toContain("papers/p-one");
    expect(await enumerate(root, "search")).not.toContain("papers/p-one");
  });

  it("concepts + queries + opted-in typed pages ARE enumerated for search", async () => {
    const ids = await enumerate(await seedMixed(), "search");
    expect(ids).toEqual(expect.arrayContaining(["concepts/c-one", "queries/q-one", "notes/n-one"]));
  });
});

describe("selectFallbackRefs — namespace correctness + privacy drop (Findings 1 & 3)", () => {
  let selectFallbackRefs: typeof import("../src/search/retrieval.js").selectFallbackRefs;
  let loadProfile: typeof import("../src/profile/load.js").loadProfile;

  beforeEach(async () => {
    vi.resetModules();
    ({ selectFallbackRefs } = await import("../src/search/retrieval.js"));
    ({ loadProfile } = await import("../src/profile/load.js"));
  });
  afterEach(() => vi.restoreAllMocks());

  /** Run the fallback selector returning a chosen set of pageId tokens. */
  async function pick(root: string, tokens: string[]): Promise<string[]> {
    await stubSelectPages(tokens);
    const profile = await loadProfile(root);
    const { refs } = await selectFallbackRefs(root, "q", "search", profile);
    return refs.map((r) => r.pageId);
  }

  it("a saved-query pick resolves to queries/<slug>, not concepts/<slug>", async () => {
    const refsIds = await pick(await seedMixed(), ["queries/q-one"]);
    expect(refsIds).toEqual(["queries/q-one"]);
  });

  it("a typed pick resolves to <type>/<slug> and a concept pick to concepts/<slug>", async () => {
    const root = await seedMixed();
    expect(await pick(root, ["notes/n-one"])).toEqual(["notes/n-one"]);
    expect(await pick(root, ["concepts/c-one"])).toEqual(["concepts/c-one"]);
  });

  it("an opted-out typed pageId returned by the LLM is DROPPED (not resolved)", async () => {
    const refsIds = await pick(await seedMixed(), ["papers/p-one"]);
    expect(refsIds).toEqual([]);
  });

  it("an unknown / non-live token is DROPPED (no fabricated concepts/<token>)", async () => {
    const refsIds = await pick(await seedMixed(), ["does-not-exist", "concepts/ghost"]);
    expect(refsIds).toEqual([]);
  });

  it("the rendered selector prompt never contains an opted-out page's id or title", async () => {
    const root = await seedMixed();
    await stubSelectPages([]);
    const profile = await loadProfile(root);
    await selectFallbackRefs(root, "q", "search", profile);
    const { callClaude } = await import("../src/utils/llm.js");
    const userMsg = vi.mocked(callClaude).mock.calls[0][0].messages[0].content as string;
    expect(userMsg).not.toContain("papers/p-one");
    expect(userMsg).not.toContain("secrets/s-one");
    expect(userMsg).not.toContain("Secret One");
    expect(userMsg).toContain("queries/q-one");
  });
});

describe("selectFallbackRefs — collision + default project", () => {
  let selectFallbackRefs: typeof import("../src/search/retrieval.js").selectFallbackRefs;
  let buildSurfaceEligibleCandidates: typeof import("../src/utils/page-registry.js").buildSurfaceEligibleCandidates;
  let buildNamespaceDirs: typeof import("../src/utils/page-registry.js").buildNamespaceDirs;
  let loadProfile: typeof import("../src/profile/load.js").loadProfile;

  beforeEach(async () => {
    vi.resetModules();
    ({ selectFallbackRefs } = await import("../src/search/retrieval.js"));
    ({ buildSurfaceEligibleCandidates, buildNamespaceDirs } = await import("../src/utils/page-registry.js"));
    ({ loadProfile } = await import("../src/profile/load.js"));
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns no refs without calling the provider when no eligible pages exist", async () => {
    const root = await makeTempRoot("f-empty");
    const profile = await loadProfile(root);
    const { callClaude } = await import("../src/utils/llm.js");

    const result = await selectFallbackRefs(root, "q", "search", profile);

    expect(result).toEqual({ refs: [], reasoning: "No eligible pages." });
    expect(callClaude).not.toHaveBeenCalled();
  });

  it("concepts/foo and an inSearch papers/foo enumerate as distinct, independently selectable", async () => {
    const root = await makeTempRoot("f-collision");
    await writeFile(path.join(root, "wiki", "index.md"), "# Index\n");
    await writeProfileFile(root, {
      schemaVersion: 1, profileId: "p", entities: { papers: { directory: "wiki/papers", retrieval: { includeInSearch: true } } },
    } as ProfilePack);
    await writePage(path.join(root, "wiki/concepts"), "foo", { title: "Concept Foo", summary: "s" }, "Concept foo.");
    await mkdir(path.join(root, "wiki/papers"), { recursive: true });
    await writePage(path.join(root, "wiki/papers"), "foo", { title: "Paper Foo", summary: "s" }, "Paper foo.");

    const profile = await loadProfile(root);
    const dirs = buildNamespaceDirs(profile.profile);
    const ids = (await buildSurfaceEligibleCandidates(root, "search", ["concepts", "queries", "papers"], dirs, profile)).map((c) => c.pageId);
    expect(ids).toEqual(expect.arrayContaining(["concepts/foo", "papers/foo"]));

    await stubSelectPages(["papers/foo"]);
    const a = await selectFallbackRefs(root, "q", "search", profile);
    expect(a.refs.map((r) => r.pageId)).toEqual(["papers/foo"]);
  });

  it("default project (no profile.json): concepts + queries enumerate and resolve; no crash", async () => {
    const root = await makeTempRoot("f-default");
    await writeFile(path.join(root, "wiki", "index.md"), "# Index\n");
    await writePage(path.join(root, "wiki/concepts"), "c-one", { title: "Concept", summary: "s" }, "Concept body.");
    await writePage(path.join(root, "wiki/queries"), "q-one", { title: "Query", summary: "s" }, "Query body.");

    await stubSelectPages(["concepts/c-one", "queries/q-one"]);
    const profile = await loadProfile(root);
    const { refs } = await selectFallbackRefs(root, "q", "search", profile);
    expect(refs.map((r) => r.pageId)).toEqual(["concepts/c-one", "queries/q-one"]);
    expect(refs.every((r) => r.kind === "index")).toBe(true);
  });
});

/**
 * @file test/catalog/typed-catalog.test.ts
 * @description The typed entity catalog of a custom-profile `local-indexed`
 * project, through the REAL set-and-prepare bodies on real disk. Preparing a
 * loadable custom profile writes a version 3 record whose capability is
 * `preparing` from the first record and `ready` at activation. The indexed
 * listing's profile block equals the incumbent collector's (pages with their
 * field-violation problems, invalid identities left out, every collector
 * problem, the totals), pages through bound keyset cursors in code-unit key
 * order, re-reads a changed row for its response and marks it stale, and
 * refuses a stale profile, a preparing capability and a foreign cursor.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { routedListPages } from "../../src/catalog/routes.js";
import { listPages, type ListPagesProfileBlock } from "../../src/pages/list.js";
import type { ScaleRecordV2 } from "../../src/scale/contracts-v2.js";
import { diskScaleRecordIo, readScaleRecord, writeScaleRecordFrom } from "../../src/scale/record.js";
import { diskScaleTransitionSteps, setExpectedScaleWith } from "../../src/scale/transition.js";
import { SAMPLE_PROFILE, writeMarkdownPage, writeProfileFile } from "../fixtures/profile-fixtures.js";

let root: string;
/** The record the preparation wrote first (at its `after-request` checkpoint). */
let firstRecord: { version?: number; capabilities?: unknown } = {};
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-typed-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Seed the custom profile with valid, field-violating, non-slug-safe and slug-mismatched pages, then prepare indexed. */
async function preparedTypedProject(): Promise<ScaleRecordV2> {
  await writeProfileFile(root, SAMPLE_PROFILE);
  for (const [slug, text] of [
    ["alpha", "---\ntitle: Alpha\n---\nA."], ["beta", "---\ntitle: Beta\n---\nB."], ["gamma", "---\ntitle: Gamma\n---\nG."],
    ["no-title", "---\nslug: no-title\n---\nMissing title."], ["Bad Name", "---\ntitle: Bad\n---\nX."], ["mismatch", "---\ntitle: M\nslug: other\n---\nY."],
  ] as const) await writeMarkdownPage(root, "wiki/notes", slug, text);
  const steps = {
    ...diskScaleTransitionSteps(root), preflight: { freeBytes: async () => Number.MAX_SAFE_INTEGER },
    // The record written BEFORE any preparation effect already fences older builds.
    checkpoint: async (stage: string) => { if (stage === "after-request") firstRecord = JSON.parse(await readFile(path.join(root, ".llmwiki", "scale.json"), "utf8")); },
  };
  const report = await setExpectedScaleWith(steps, { request: { documents: 8_000 } });
  expect([report.readiness, report.record?.active.architecture]).toEqual(["ready", "local-indexed"]);
  return report.record as ScaleRecordV2;
}

/** A canonical form of a profile block for comparison: pages by id, problems sorted. */
function canonical(block: ListPagesProfileBlock | undefined) {
  const pages = [...(block?.entityPages ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1));
  const problems = [...(block?.problems ?? [])].map((problem) => JSON.stringify(problem)).sort();
  return { pages, problems, total: block?.total, problemTotal: block?.problemTotal };
}

/** Expect cursors that decode to JSON null, an array or a number, and one over the length cap, to be refused as stale for both windows. */
async function expectMalformedCursorsStale(): Promise<void> {
  for (const json of ["null", "[]", "7"]) {
    const cursor = `t1.${Buffer.from(json).toString("base64url")}`;
    await expect(routedListPages(root, { limit: 1, profileCursor: cursor })).rejects.toMatchObject({ code: "catalog_cursor_stale" });
    await expect(routedListPages(root, { limit: 1, problemCursor: cursor })).rejects.toMatchObject({ code: "catalog_cursor_stale" });
  }
  await expect(routedListPages(root, { limit: 1, profileCursor: `t1.${"A".repeat(12 * 512 + 1)}` })).rejects.toMatchObject({ code: "catalog_cursor_stale" });
}

describe("preparation", () => {
  it("records the capability preparing first and ready at activation, as version 3", async () => {
    const record = await preparedTypedProject();
    expect([firstRecord.version, firstRecord.capabilities]).toEqual([3, [{ name: "typed-entity-catalog-1", status: "preparing" }]]);
    expect([record.version, record.capabilities]).toEqual([3, [{ name: "typed-entity-catalog-1", status: "ready" }]]);
    expect(JSON.parse(await readFile(path.join(root, ".llmwiki", "scale.json"), "utf8")).version).toBe(3);
  });
});

describe("the indexed profile block", () => {
  it("equals the incumbent collector's block", async () => {
    await preparedTypedProject();
    const indexed = await routedListPages(root, { limit: 1000 });
    const incumbent = await listPages(root, {});
    expect(canonical(indexed.profile)).toEqual(canonical(incumbent.profile));
    expect(indexed.profile?.entityPages.map((page) => page.slug)).toEqual(["alpha", "beta", "gamma", "no-title"]);
    expect(indexed.profile?.problems?.map((problem) => problem.kind).sort()).toEqual(["field-violation", "non-slug-safe-filename", "slug-mismatch"]);
  });

  it("pages through bound cursors, and refuses a foreign or offset cursor", async () => {
    await preparedTypedProject();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await routedListPages(root, { limit: 1, ...(cursor === undefined ? {} : { profileCursor: cursor }) });
      seen.push(...page.profile!.entityPages.map((view) => view.slug));
      cursor = page.profile!.cursor;
    } while (cursor !== undefined);
    expect(seen).toEqual(["alpha", "beta", "gamma", "no-title"]);
    const first = (await routedListPages(root, { limit: 1 })).profile!.cursor!;
    const foreign = `t1.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(first.slice(3), "base64url").toString()), c: "0".repeat(32) })).toString("base64url")}`;
    await expect(routedListPages(root, { limit: 1, profileCursor: foreign })).rejects.toMatchObject({ code: "catalog_cursor_stale" });
    await expect(routedListPages(root, { limit: 1, profileCursor: "1" })).rejects.toMatchObject({ code: "catalog_cursor_stale" });
    await expectMalformedCursorsStale();
  });

  it("pages problems through their own cursor", async () => {
    await preparedTypedProject();
    const kinds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await routedListPages(root, { limit: 1, ...(cursor === undefined ? {} : { problemCursor: cursor }) });
      kinds.push(...(page.profile!.problems ?? []).map((problem) => problem.kind));
      cursor = page.profile!.problemCursor;
    } while (cursor !== undefined);
    expect(kinds.sort()).toEqual(["field-violation", "non-slug-safe-filename", "slug-mismatch"]);
  });
});

describe("freshness and admission", () => {
  it("re-reads a changed row for its response and marks the listing stale, keeping the catalogued total", async () => {
    await preparedTypedProject();
    await writeMarkdownPage(root, "wiki/notes", "alpha", "---\ntitle: Alpha Two\n---\nA2.");
    const listed = await routedListPages(root, { limit: 1000 });
    expect(listed.profile!.entityPages.find((page) => page.slug === "alpha")!.title).toBe("Alpha Two");
    expect([listed.catalog?.state, listed.catalog?.staleRows?.count, listed.profile!.total]).toEqual(["stale", 1, 4]);
  });

  it("refuses a catalog built for another profile, and a preparing capability", async () => {
    const record = await preparedTypedProject();
    await writeScaleRecordFrom(diskScaleRecordIo(root), { ...record, revision: record.revision, capabilities: [{ name: "typed-entity-catalog-1", status: "preparing" }] }, record);
    await expect(routedListPages(root)).rejects.toMatchObject({ code: "catalog_typed_preparing" });
    const current = await readScaleRecord(root);
    await writeScaleRecordFrom(diskScaleRecordIo(root), { ...(current.kind === "ok" ? current.record : record), capabilities: [{ name: "typed-entity-catalog-1", status: "ready" }] } as ScaleRecordV2, current.kind === "ok" ? current.record : record);
    await writeFile(path.join(root, ".llmwiki", "profile.json"), JSON.stringify({ ...SAMPLE_PROFILE, entities: { notes: { ...SAMPLE_PROFILE.entities.notes, fields: { title: { type: "string" }, extra: { type: "string" } } } } }));
    await expect(routedListPages(root)).rejects.toMatchObject({ code: "catalog_profile_stale" });
  });
});

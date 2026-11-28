/**
 * @file test/catalog/typed-rows.test.ts
 * @description Corruption and bounding cases of the typed entity catalog on a
 * custom-profile `local-indexed` project prepared through the real bodies:
 * stored rows are closed and bound to their key (unknown problem kinds, a
 * view naming another entity, an extra field and a forged directory stamp are
 * corrupt; arbitrary valid frontmatter is not); full verification refuses an
 * entity row (a `null` page or a directory row) of a type the typed catalog
 * does not declare; a cursor with a negative problem index is refused; and on
 * a sparse catalog (many rows, few problems) a problem window stops on its
 * examined-row budget with a continuation that still reaches every problem.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { asEntityDirRow, asEntityFileRow } from "../../src/catalog/entity-rows.js";
import { routedListPages } from "../../src/catalog/routes.js";
import { verifyIndexedStores } from "../../src/indexed/verify.js";
import { setIndexedScale } from "./cli-helpers.js";
import { diskSegmentStoreIo } from "../../src/segments/io.js";
import { SegmentStore } from "../../src/segments/store.js";
import { SAMPLE_PROFILE, writeMarkdownPage, writeProfileFile } from "../fixtures/profile-fixtures.js";

/** Valid pages added to make the catalog sparse in problems. */
const SPARSE_VALID_PAGES = 25;
const STAMP = { size: 3, mtimeNs: "1", ino: "2" };

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-typed-rows-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Prepare `local-indexed` over the sample profile with `valid` valid pages and three problem pages. */
async function prepared(valid: number): Promise<void> {
  await writeProfileFile(root, SAMPLE_PROFILE);
  for (let at = 0; at < valid; at += 1) await writeMarkdownPage(root, "wiki/notes", `ok-${String(at).padStart(3, "0")}`, `---\ntitle: Ok ${at}\n---\nFine.`);
  // The problem pages sort AFTER the valid ones (code-unit key order), so a sparse window meets them last.
  for (const [slug, text] of [["zz-no-title", "---\nslug: zz-no-title\n---\nX."], ["zz bad", "---\ntitle: Bad\n---\nX."], ["zz-mismatch", "---\ntitle: M\nslug: other\n---\nY."]] as const) {
    await writeMarkdownPage(root, "wiki/notes", slug, text);
  }
  await setIndexedScale(root);
}

describe("stored rows are closed and bound to their key", () => {
  const view = { entityType: "notes", directory: "wiki/notes", slug: "a", id: "notes/a", path: "wiki/notes/a.md", frontmatter: { title: "A", any: { nested: [1] } } };
  it("accept a valid row with arbitrary frontmatter", () => {
    expect(asEntityFileRow({ stamp: STAMP, page: view, problems: [] }, "e:notes/a").page).toEqual(view);
  });

  it("refuse an unknown problem kind, a view of another entity, an extra field, and a forged directory stamp", () => {
    const problem = { kind: "relation-store", entityType: "notes", message: "m" };
    expect(() => asEntityFileRow({ stamp: STAMP, page: null, problems: [problem] }, "e:notes/a")).toThrow(/malformed/);
    expect(() => asEntityFileRow({ stamp: STAMP, page: { ...view, slug: "b", id: "notes/b" }, problems: [] }, "e:notes/a")).toThrow(/malformed/);
    expect(() => asEntityFileRow({ stamp: STAMP, page: view, problems: [], extra: 1 }, "e:notes/a")).toThrow(/malformed/);
    expect(() => asEntityDirRow({ dir: { forged: true }, problems: [] }, "e:notes/")).toThrow(/malformed/);
  });
});

describe("full verification", () => {
  it.each([["a null-page file row", "e:ghost/x", { stamp: STAMP, page: null, problems: [] }], ["a directory row", "e:ghost/", { dir: null, problems: [] }]])(
    "refuses %s of an undeclared type, though every count still matches", async (_label, key, value) => {
      await prepared(0);
      expect((await verifyIndexedStores(root)).ok).toBe(true);
      await (await SegmentStore.open(diskSegmentStoreIo(root, "catalog"))).commit({ rows: [{ k: key, v: value }] });
      const report = await verifyIndexedStores(root);
      const catalog = report.stores.find((store) => store.store === "catalog")!;
      expect([report.ok, catalog.ok]).toEqual([false, false]);
      expect(catalog.problems.join("\n")).toMatch(/type its typed catalog does not declare/);
    });
});

describe("cursors and problem windows", () => {
  it("refuse a cursor whose problem index is negative", async () => {
    await prepared(0);
    const first = (await routedListPages(root, { limit: 1 })).profile!.problemCursor!;
    const decoded = JSON.parse(Buffer.from(first.slice(3), "base64url").toString()) as Record<string, unknown>;
    const negative = `t1.${Buffer.from(JSON.stringify({ ...decoded, i: -1 })).toString("base64url")}`;
    await expect(routedListPages(root, { limit: 1, problemCursor: negative })).rejects.toMatchObject({ code: "catalog_cursor_stale" });
  });

  it("stop a sparse problem window on its examined-row budget and still reach every problem through the continuation", async () => {
    await prepared(SPARSE_VALID_PAGES);
    const first = await routedListPages(root, { limit: 1 });
    expect([first.profile!.problems, first.catalog?.scanBudgetExhausted]).toEqual([[], true]);
    const kinds: string[] = [];
    let cursor = first.profile!.problemCursor;
    while (cursor !== undefined) {
      const page = await routedListPages(root, { limit: 1, problemCursor: cursor });
      kinds.push(...(page.profile!.problems ?? []).map((problem) => problem.kind));
      cursor = page.profile!.problemCursor;
    }
    expect(kinds.sort()).toEqual(["field-violation", "non-slug-safe-filename", "slug-mismatch"]);
  });
});

/**
 * Export -> import round trip: no instant is invented anywhere along the way.
 *
 * This is the durability half of the timestamp contract. `okf-map.ts` maps an
 * OKF doc's `timestamp` back onto `updatedAt`, so anything the exporter puts
 * there is written into real frontmatter by `llmwiki import --okf` and is then
 * indistinguishable from a timestamp the compiler actually recorded. A page
 * that declared no time before the round trip must still declare none after it.
 *
 * The assertions read the mapped page body, which is byte-for-byte what a
 * `--trusted` import writes to `wiki/<dir>/<slug>.md` (see `writeAll` in
 * src/import/run.ts) — the same bytes, without needing the project lock.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { rm, mkdir } from "fs/promises";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { collectExportPages } from "../src/export/collect.js";
import { buildOkfBundle } from "../src/export/okf/bundle.js";
import { importOkfBundle } from "../src/import/okf-import.js";

const QUERY_CREATED = "2024-02-02T00:00:00.000Z";

/** Exactly the frontmatter `query --save` writes: a top-level `type`, no `updatedAt`. */
const SAVED_QUERY = { title: "Why?", summary: "Because.", type: "query", createdAt: QUERY_CREATED };

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Seed a wiki holding an undated concept and a saved query, then return its root. */
async function seedWiki(): Promise<string> {
  dir = await makeTempRoot("export-rt");
  const undated = { title: "Undated", summary: "s" };
  await writePage(path.join(dir, "wiki/concepts"), "undated", undated, "Body.");
  await writePage(path.join(dir, "wiki/queries"), "why", SAVED_QUERY, "Body.");
  return dir;
}

/** Export the wiki as an OKF bundle, import it into a fresh project, and return each page's frontmatter. */
async function roundTrip(root: string): Promise<Map<string, Record<string, unknown>>> {
  const bundle = path.join(root, "bundle");
  await buildOkfBundle(root, await collectExportPages(root), bundle, () => {});
  const fresh = path.join(root, "fresh-project");
  await mkdir(fresh, { recursive: true });
  const { pages } = await importOkfBundle(bundle, fresh);
  return new Map(pages.map((page) => [page.slug, parseFrontmatter(page.body).meta]));
}

describe("OKF round trip never fabricates a timestamp", () => {
  it("leaves a page that declared no update time still declaring none", async () => {
    const frontmatter = (await roundTrip(await seedWiki())).get("undated")!;
    expect(frontmatter).not.toHaveProperty("updatedAt");
  });

  it("carries a saved query's own instant through instead of an export-run clock", async () => {
    const frontmatter = (await roundTrip(await seedWiki())).get("why")!;
    expect(frontmatter.updatedAt).toBe(QUERY_CREATED);
  });

  it("records the saved query as a query, not as a concept", async () => {
    const frontmatter = (await roundTrip(await seedWiki())).get("why")!;
    expect(frontmatter["x-okf"]).toMatchObject({ type: "query" });
  });
});

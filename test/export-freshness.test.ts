/**
 * Verifies that computed source-freshness flows into the JSON export contract:
 * each page carries `freshnessStatus` / `contradicted` / `archived`, and
 * computed-orphaned pages (every owning source deleted) are dropped so the
 * export stays active-page-only and never emits `freshnessStatus: "orphaned"`.
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { createHash } from "node:crypto";
import { writePage } from "./fixtures/write-page.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writeTestStateJson } from "./fixtures/state-json.js";
import { collectExportPages } from "../src/export/collect.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function writeSource(root: string, file: string, content: string) {
  await mkdir(path.join(root, "sources"), { recursive: true });
  await writeFile(path.join(root, "sources", file), content);
}

async function state(root: string, sources: Record<string, { hash: string; concepts: string[] }>) {
  const entries = Object.fromEntries(
    Object.entries(sources).map(([f, s]) => [f, { ...s, compiledAt: "t" }]),
  );
  await writeTestStateJson(root, { version: 1, indexHash: "", sources: entries });
}

describe("export freshness fields", () => {
  it("marks a page stale when its source changed since compile", async () => {
    const root = await makeTempRoot("export-fresh-stale");
    await writeSource(root, "a.md", "NEW body");
    await state(root, { "a.md": { hash: sha("OLD body"), concepts: ["topic"] } });
    await writePage(path.join(root, "wiki/concepts"), "topic", { title: "Topic", summary: "s" }, "Body.\n");

    const [page] = await collectExportPages(root);
    expect(page.freshnessStatus).toBe("stale");
    expect(page.contradicted).toBe(false);
    expect(page.archived).toBe(false);
  });

  it("surfaces contradicted and archived as orthogonal axes", async () => {
    const root = await makeTempRoot("export-fresh-flags");
    await writePage(
      path.join(root, "wiki/concepts"),
      "disputed",
      { title: "Disputed", summary: "s", contradictedBy: [{ slug: "other" }], archived: true },
      "Body.\n",
    );

    const [page] = await collectExportPages(root);
    expect(page.contradicted).toBe(true);
    expect(page.archived).toBe(true);
    expect(page.freshnessStatus).toBe("unverified"); // no source ownership in state
  });

  it("drops computed-orphaned pages (all owning sources deleted) from the export", async () => {
    const root = await makeTempRoot("export-fresh-orphan");
    // g.md owns "ghost" in state but the source file is gone from disk.
    await state(root, { "g.md": { hash: sha("gone"), concepts: ["ghost"] } });
    await writePage(path.join(root, "wiki/concepts"), "ghost", { title: "Ghost", summary: "s" }, "Body.\n");
    await writePage(path.join(root, "wiki/concepts"), "alive", { title: "Alive", summary: "s" }, "Body.\n");

    const slugs = (await collectExportPages(root)).map((p) => p.slug);
    expect(slugs).toContain("alive");
    expect(slugs).not.toContain("ghost");
  });
});

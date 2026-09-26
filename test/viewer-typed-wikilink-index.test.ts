/**
 * Regression tests: typed entity pages are never wikilink targets.
 *
 * A non-default profile's snapshot page list holds typed entity pages
 * (`papers/…`, `ideas/…`) next to concept and query pages, and the viewer
 * renderer resolves every `[[slug]]` against that whole list. Only concept and
 * query pages may be targets. A typed page sharing a slug or alias must neither
 * mint a link to a nonexistent `concepts/<slug>` page nor shadow a real query.
 *
 * The first block drives the real snapshot builder and renderer over a
 * research-profile project; the second pins alias precedence directly.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import { renderPageHtml } from "../src/viewer/render.js";
import { resolveBareSlug } from "../src/viewer/collect.js";
import type { ViewerPageId } from "../src/viewer/types.js";
import { buildResearchLiteRelationsProject } from "./fixtures/profile-fixtures.js";
import { writePage } from "./fixtures/write-page.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "viewer-typed-wikilink-"));
  await buildResearchLiteRelationsProject(root);
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** Render one body against the project's real viewer snapshot. */
async function renderAgainstSnapshot(body: string): Promise<string> {
  const snapshot = await buildViewerSnapshot(root);
  return renderPageHtml(body, snapshot, { isLoopback: true }).html;
}

describe("viewer wikilinks in a profile project", () => {
  it("leaves a slug only a typed page carries unresolved", async () => {
    const html = await renderAgainstSnapshot("See [[sparse-routing]].");
    expect(html).toContain('<span data-missing="true">[[sparse-routing]]</span>');
    expect(html).not.toContain("concepts/sparse-routing");
  });

  it("resolves a slug shared by a typed page and a query to the query", async () => {
    await mkdir(path.join(root, "wiki/queries"), { recursive: true });
    await writePage(path.join(root, "wiki/queries"), "scaling-laws", { title: "Scaling laws?" }, "Answer.");
    const html = await renderAgainstSnapshot("See [[scaling-laws]].");
    expect(html).toContain('data-page-id="queries/scaling-laws"');
    expect(html).not.toContain("concepts/scaling-laws");
  });
});

/** Build a minimal index entry for `resolveBareSlug`. */
function entry(pageDirectory: string, slug: string, aliases: string[] = []) {
  return { id: `${pageDirectory}/${slug}` as ViewerPageId, pageDirectory, slug, aliases };
}

describe("resolveBareSlug alias precedence with typed pages", () => {
  it("resolves an alias shared with a typed page to the query that declares it", () => {
    const pages = [entry("papers", "paper-one", ["Bar Baz"]), entry("queries", "question", ["Bar Baz"])];
    expect(resolveBareSlug("bar-baz", pages)).toBe("queries/question");
  });

  it("leaves an alias only a typed page declares unresolved", () => {
    const pages = [entry("papers", "paper-one", ["Qux"]), entry("concepts", "other")];
    expect(resolveBareSlug("qux", pages)).toBeNull();
    expect(resolveBareSlug("paper-one", pages)).toBeNull();
  });
});

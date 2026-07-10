/**
 * @file Integration tests for profile-aware OKF export (CLP 7.6 Task 1).
 *
 * Verifies that an OKF bundle for a NON-DEFAULT profile project emits one entity
 * doc per live typed page at `<entityType>/<slug>.md` — carrying the mapped OKF
 * `type`, the `x-llmwiki.entityType`, and the explicit `x-llmwiki.lifecycle`
 * block — and one index TOC section per entity type. Two dissimilar profiles
 * (research, newsroom) drive the SAME code (genericity), the `export.okfType`
 * hook overrides the OKF `type`, and a default-profile project emits NO entity
 * docs or sections (byte-identical parity, D-7.6.10).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { buildOkfBundle } from "../src/export/okf/bundle.js";
import { collectProfileEntityDocs } from "../src/export/okf/profile-docs.js";
import { loadNonDefaultProfile } from "../src/profile/block.js";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { PROFILE_FILE } from "../src/utils/constants.js";
import { buildResearchProject } from "./fixtures/research-profile.js";
import { buildNewsroomProject, NEWSROOM_PROFILE } from "./fixtures/newsroom-profile.js";
import { writeSeedPage } from "./fixtures/seed-page.js";
import { exportDefaultBundleIndex } from "./fixtures/default-export-page.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "okf-profile-")); });

/** Export the project (no native concept/query pages) and return the bundle dir. */
async function exportEntityBundle(from: string): Promise<string> {
  const out = path.join(from, "bundle");
  await buildOkfBundle(from, [], out);
  return out;
}

/** Parse an entity doc's frontmatter from the bundle. */
async function readDoc(out: string, rel: string): Promise<Record<string, unknown>> {
  const { meta } = parseFrontmatter(await readFile(path.join(out, rel), "utf-8"));
  return meta;
}

describe("profile-aware OKF export", () => {
  it("emits papers/<slug>.md with type, x-llmwiki.entityType, and lifecycle", async () => {
    await buildResearchProject(root);
    const out = await exportEntityBundle(root);
    const meta = await readDoc(out, "papers/attention-is-all-you-need.md");
    expect(meta.type).toBe("papers");
    const x = meta["x-llmwiki"] as Record<string, unknown>;
    expect(x.entityType).toBe("papers");
    expect(x.lifecycle).toEqual({ field: "stage", state: "distilled" });
  });

  it("honors the export.okfType hook for the OKF type", async () => {
    await mkdir(path.join(root, path.dirname(PROFILE_FILE)), { recursive: true });
    const profile = structuredClone(NEWSROOM_PROFILE);
    profile.entities.articles.export = { okfType: "NewsArticle" };
    await writeFile(path.join(root, PROFILE_FILE), `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    await writeSeedPage(root, { directory: "wiki/articles", slug: "port-strike",
      frontmatter: "headline: Port Strike\nstage: published", body: "Dock strike coverage." });
    const out = await exportEntityBundle(root);
    const meta = await readDoc(out, "articles/port-strike.md");
    expect(meta.type).toBe("NewsArticle");
    expect((meta["x-llmwiki"] as Record<string, unknown>).entityType).toBe("articles");
  });

  it("emits articles/<slug>.md for the newsroom profile (second profile, same code)", async () => {
    await buildNewsroomProject(root);
    const out = await exportEntityBundle(root);
    const meta = await readDoc(out, "articles/port-strike-latest.md");
    expect(meta.type).toBe("articles");
    const x = meta["x-llmwiki"] as Record<string, unknown>;
    expect(x.entityType).toBe("articles");
    expect(x.lifecycle).toEqual({ field: "stage", state: "published" });
  });

  it("lists an entity TOC section per type in index.md", async () => {
    await buildNewsroomProject(root);
    const out = await exportEntityBundle(root);
    const index = await readFile(path.join(out, "index.md"), "utf-8");
    expect(index).toContain("## Articles");
    expect(index).toContain("(/articles/port-strike-latest.md)");
    expect(index).toContain("## Desks");
  });

  it("emits no entity docs or sections for a default-profile project", async () => {
    const { out, index } = await exportDefaultBundleIndex(root);
    expect(index).toContain("## Concepts");
    expect(index).not.toMatch(/## (Papers|Articles|Desks)/);
    expect((await readdir(out)).sort()).toEqual(["concepts", "index.md", "log.md"]);
  });

  it("collectProfileEntityDocs returns [] for a default project", async () => {
    const loaded = await loadNonDefaultProfile(root);
    expect(await collectProfileEntityDocs(root, () => null, loaded)).toEqual([]);
  });
});

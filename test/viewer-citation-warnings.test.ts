/**
 * Citation warnings produced by `buildViewerSnapshot`.
 *
 * Unresolved citations (file not under `sources/`) and malformed
 * citation entries (broken line-range grammar) must surface as
 * `ViewerPage.warnings` entries so the support rail can show them.
 * The Slice 1 collector only emitted parser-level warnings; this
 * coverage is the snapshot's responsibility because resolvability
 * depends on the snapshot's source-file list.
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";

async function writeSource(root: string, name: string): Promise<void> {
  await mkdir(path.join(root, "sources"), { recursive: true });
  await writeFile(path.join(root, "sources", name), "# source");
}

function warningCodes(snapshot: { pages: Array<{ slug: string; warnings: Array<{ code: string }> }> }, slug: string): string[] {
  const page = snapshot.pages.find((p) => p.slug === slug);
  if (!page) throw new Error(`fixture page ${slug} missing`);
  return page.warnings.map((w) => w.code);
}

describe("buildViewerSnapshot — citation warnings", () => {
  it("emits `unresolved_citation` for a citation whose source file is not under sources/", async () => {
    const root = await makeTempRoot("citation-warn-unresolved");
    await writeSource(root, "known.md");
    await writePage(
      path.join(root, "wiki/concepts"),
      "alpha",
      { title: "Alpha" },
      "A claim ^[known.md] and a missing source ^[ghost.md].",
    );
    const snapshot = await buildViewerSnapshot(root);
    const codes = warningCodes(snapshot, "alpha");
    expect(codes).toContain("unresolved_citation");
    const page = snapshot.pages.find((p) => p.slug === "alpha")!;
    const ghostWarning = page.warnings.find(
      (w) => w.code === "unresolved_citation" && w.message.includes("ghost.md"),
    );
    expect(ghostWarning).not.toBeUndefined();
    // The resolved citation does NOT produce a warning.
    const knownWarning = page.warnings.find(
      (w) => w.code === "unresolved_citation" && w.message.includes("known.md"),
    );
    expect(knownWarning).toBeUndefined();
  });

  it("emits `malformed_citation` for a citation entry with a broken line range", async () => {
    const root = await makeTempRoot("citation-warn-malformed");
    await writeSource(root, "src.md");
    await writePage(
      path.join(root, "wiki/concepts"),
      "alpha",
      { title: "Alpha" },
      "A claim ^[src.md:0-5] with a zero start line.",
    );
    const snapshot = await buildViewerSnapshot(root);
    const codes = warningCodes(snapshot, "alpha");
    expect(codes).toContain("malformed_citation");
  });

  it("emits no citation warnings when every span resolves and the grammar is clean", async () => {
    const root = await makeTempRoot("citation-warn-clean");
    await writeSource(root, "src.md");
    await writePage(
      path.join(root, "wiki/concepts"),
      "alpha",
      { title: "Alpha" },
      "A claim ^[src.md] and a span ^[src.md:42-58].",
    );
    const snapshot = await buildViewerSnapshot(root);
    const codes = warningCodes(snapshot, "alpha");
    expect(codes).not.toContain("unresolved_citation");
    expect(codes).not.toContain("malformed_citation");
  });
});

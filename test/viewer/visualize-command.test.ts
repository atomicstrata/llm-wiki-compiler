/**
 * @file test/viewer/visualize-command.test.ts
 * @description `llmwiki visualize` end to end on a real project tree: it emits
 * the two navigation artifacts, and re-running it preserves whatever the user
 * has edited since.
 *
 * THE SECOND RUN IS THE POINT. A "regenerate" verb that discarded hand-edited
 * colours or a rearranged canvas would be one nobody dares run twice, so this
 * asserts the BYTES of a customized file survive — a "skipped" report beside a
 * rewritten file would be the worst of both.
 */

import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import visualizeCommand from "../../src/commands/visualize.js";

/** A minimal compiled wiki: two pages, one linking to the other. */
async function wikiProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vis-"));
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await writeFile(path.join(root, "wiki", "concepts", "alpha.md"),
    "---\ntitle: Alpha\n---\n\nAlpha links to [[beta]].\n", "utf8");
  await writeFile(path.join(root, "wiki", "concepts", "beta.md"),
    "---\ntitle: Beta\n---\n\nBeta stands alone.\n", "utf8");
  return root;
}

/** Read one emitted artifact as JSON. */
async function readArtifact(root: string, relative: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, relative), "utf8")) as Record<string, unknown>;
}

describe("llmwiki visualize", () => {
  it("emits the Obsidian config and a canvas, and exits 0", async () => {
    const root = await wikiProject();
    expect(await visualizeCommand(root)).toBe(0);
    expect(await readArtifact(root, "wiki/.obsidian/graph.json")).toHaveProperty("colorGroups");
    const canvas = await readArtifact(root, "wiki/canvases/knowledge-map.canvas");
    expect(Array.isArray(canvas.nodes)).toBe(true);
    expect((canvas.nodes as unknown[]).length).toBeGreaterThan(0);
  }, 60_000);

  it("re-running PRESERVES a customization, byte for byte", async () => {
    const root = await wikiProject();
    expect(await visualizeCommand(root)).toBe(0);
    // The operator edits their colours by hand, as people do.
    await writeFile(path.join(root, "wiki/.obsidian/graph.json"), '{"colorGroups":["MINE"]}', "utf8");
    expect(await visualizeCommand(root)).toBe(0);
    expect(await readFile(path.join(root, "wiki/.obsidian/graph.json"), "utf8"))
      .toBe('{"colorGroups":["MINE"]}');
  }, 60_000);

  it("refuses a --focus naming no node, rather than writing an empty map", async () => {
    const root = await wikiProject();
    // Silently emitting an empty canvas would look like "this node has no
    // neighbours" when the truth is "that node does not exist".
    expect(await visualizeCommand(root, { focus: "concepts/nonexistent" })).toBe(1);
  }, 60_000);

  it("writes a focus-named canvas beside the full map, not over it", async () => {
    const root = await wikiProject();
    await visualizeCommand(root);
    expect(await visualizeCommand(root, { focus: "concepts/alpha", depth: "1" })).toBe(0);
    await readArtifact(root, "wiki/canvases/knowledge-map.canvas");
    await readArtifact(root, "wiki/canvases/concepts-alpha.canvas");
  }, 60_000);
});

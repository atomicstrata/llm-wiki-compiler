/**
 * Graph theming contract.
 *
 * D3 sets SVG presentation attributes, which cannot read CSS custom
 * properties — a graph coloured that way stays dark when the viewer
 * switches to the light theme. These tests pin the class-based approach
 * that replaced it: JS assigns semantic classes, the stylesheet owns
 * every colour.
 */

import { describe, expect, it } from "bun:test";
import { readFile } from "fs/promises";
import path from "path";

const GRAPH_MODULE = path.resolve("src/viewer/assets/viewer-graph.js");
const GRAPH_STYLES = path.resolve("src/viewer/assets/viewer-graph.css");

/** Hex colour literals that must no longer appear in the module. */
const HEX_PATTERN = /#[0-9a-fA-F]{3,8}\b/g;

describe("graph theming", () => {
  it("declares no hex colour literals in the JS module", async () => {
    const source = await readFile(GRAPH_MODULE, "utf-8");
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(withoutComments.match(HEX_PATTERN)).toBeNull();
  });

  it("assigns semantic node classes rather than fill attributes", async () => {
    const source = await readFile(GRAPH_MODULE, "utf-8");
    expect(source).toContain("graph-node--");
    expect(source).not.toMatch(/\.attr\(\s*['"]fill['"]/);
  });

  it("styles the four design-system node semantics from tokens", async () => {
    const css = await readFile(GRAPH_STYLES, "utf-8");
    for (const kind of ["concept", "entity", "stale", "dangling"]) {
      expect(css).toContain(`.graph-node--${kind}`);
    }
    expect(css).toContain("var(--");
  });

  it("keeps the canvas label-free", async () => {
    const source = await readFile(GRAPH_MODULE, "utf-8");
    expect(source).not.toContain("node-label");
    expect(source).not.toMatch(/append\(\s*['"]text['"]\s*\)/);
  });

  it("gives the focused node a halo ring", async () => {
    const css = await readFile(GRAPH_STYLES, "utf-8");
    expect(css).toContain(".graph-halo");
    expect(css).toMatch(/\.graph-halo\.is-hot/);
  });

  it("derives stale node ids from the pages envelope", async () => {
    const source = await readFile(GRAPH_MODULE, "utf-8");
    expect(source).toContain("staleIdsFromEnvelope");
    expect(source).toContain("freshnessStatus");
  });

  it("declares no raw colour literals in the graph stylesheet", async () => {
    const css = await readFile(GRAPH_STYLES, "utf-8");
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(withoutComments.match(HEX_PATTERN)).toBeNull();
  });

  it("keeps data-derived geometry in JS", async () => {
    const source = await readFile(GRAPH_MODULE, "utf-8");
    expect(source).toMatch(/\.attr\(\s*['"]r['"]/);
  });
});

/**
 * Compact graph mode.
 *
 * The dashboard panel renders a real graph, not a decorative picture, so it
 * shares one fetch path and one simulation builder with #/graph. Compact
 * mode is options-only — it must never become a second renderer. One test
 * pins full mode's own numbers (unchanged since before this file existed)
 * so a future compact-mode tweak cannot silently shift them too; the next
 * pins the opposite for compact — that its forces stay derived from panel
 * size and node count rather than drifting back to a fixed pair.
 */

import { describe, expect, it } from "bun:test";
import { readFile } from "fs/promises";
import path from "path";

const GRAPH_MODULE = path.resolve("src/viewer/assets/viewer-graph.js");
const DASHBOARD_MODULE = path.resolve("src/viewer/assets/viewer-dashboard.js");

describe("compact graph mode", () => {
  it("accepts an options argument on loadGraph", async () => {
    const source = await readFile(GRAPH_MODULE, "utf-8");
    expect(source).toMatch(/export\s+async\s+function\s+loadGraph\s*\(\s*container\s*,\s*options/);
  });

  it("keeps a single fetch path", async () => {
    const source = await readFile(GRAPH_MODULE, "utf-8");
    const fetches = source.match(/fetch\(/g) ?? [];
    expect(fetches).toHaveLength(1);
  });

  it("keeps a single force-simulation builder", async () => {
    const source = await readFile(GRAPH_MODULE, "utf-8");
    const sims = source.match(/forceSimulation\(/g) ?? [];
    expect(sims).toHaveLength(1);
  });

  it("skips the legend in compact mode", async () => {
    const source = await readFile(GRAPH_MODULE, "utf-8");
    expect(source).toMatch(/if\s*\(\s*!\s*options\.compact\s*\)\s*buildLegend/);
  });

  it("has the dashboard render into the graph panel", async () => {
    const source = await readFile(DASHBOARD_MODULE, "utf-8");
    expect(source).toContain("loadGraph");
    expect(source).toContain("compact: true");
  });

  it("keeps full mode's forces and radii at their pre-compact values", async () => {
    const source = await readFile(GRAPH_MODULE, "utf-8");
    expect(source).toMatch(
      /full:\s*\{\s*linkDistance:\s*80,\s*charge:\s*-200,\s*minRadius:\s*4,\s*maxRadius:\s*10,\s*drag:\s*true\s*\}/,
    );
  });

  it("derives compact mode's link distance and charge from panel size and node count, not fixed numbers", async () => {
    // The pre-fidelity-pass compact entry hardcoded linkDistance/charge — a
    // magic pair tuned for one viewport (a ~268px panel that turned out to
    // be a mis-measurement) that left an 8-node graph a tiny knot in the
    // real, much bigger, fluid-width panel. MODE_SETTINGS.compact must not
    // carry either back in as fixed numbers; both must come from the live
    // panel area and node count instead.
    const source = await readFile(GRAPH_MODULE, "utf-8");
    const compactEntry = source.match(/compact:\s*\{[^}]*\}/)?.[0] ?? "";
    expect(compactEntry).not.toMatch(/linkDistance/);
    expect(compactEntry).not.toMatch(/charge/);
    expect(source).toMatch(/nodeCount/);
  });
});

/**
 * @file src/commands/visualize.ts
 * @description `llmwiki visualize` — regenerate the derived navigation
 * artifacts (AS-1 §4.9): an Obsidian graph configuration with per-entity-type
 * colour groups, and a Canvas knowledge map with typed, labelled edges.
 *
 * IT READS THE SAME GRAPH THE VIEWER SERVES, through `buildViewerSnapshot`, so
 * the exported map and the interactive graph can never disagree about what the
 * wiki contains. A second traversal written for export would be a second answer
 * to the same question.
 *
 * IT NEVER OVERWRITES. Both artifacts are files a person edits — colours,
 * filters, canvas layout — so an existing one is preserved and reported as
 * skipped. That is what makes this safe to re-run, and re-running is the whole
 * point of a "regenerate" verb.
 *
 * THE INTERACTIVE GRAPH IS NOT THIS COMMAND'S JOB. §4.9 asks that exploration
 * be served by the local app rather than a standalone HTML file, so this points
 * at `llmwiki view` instead of emitting a viewer of its own.
 */

import path from "node:path";
import { buildViewerSnapshot } from "../viewer/snapshot.js";
import { loadProfile } from "../profile/load.js";
import {
  canvasDocument, focusSubgraph, obsidianGraphConfig,
} from "../viewer/navigation-artifacts.js";
import { writeDerivedArtifact, type ArtifactWriteResultV1 } from "../viewer/navigation-write.js";
import * as output from "../utils/output.js";
import type { GraphData } from "../viewer/types.js";

/** Where each artifact lands, under the wiki tree the reading tools scan. */
const OBSIDIAN_CONFIG = path.join("wiki", ".obsidian", "graph.json");
const CANVAS_DIR = path.join("wiki", "canvases");

/** CLI options for `llmwiki visualize`. */
export interface VisualizeOptions {
  /** Centre the canvas on one node id (`<entityType>/<slug>`). */
  focus?: string;
  /** Hops to include around `--focus`. Ignored without it. */
  depth?: string;
}

/** The profile's declared entity types, or none for a default project. */
async function declaredEntityTypes(root: string): Promise<string[]> {
  const { profile, loadedFrom } = await loadProfile(root);
  if (loadedFrom === null) return [];
  return Object.keys((profile as { entities?: Record<string, unknown> }).entities ?? {});
}

/** The graph to render: the whole wiki, or a neighbourhood around one node. */
function selectedGraph(graph: GraphData, options: VisualizeOptions): GraphData {
  if (options.focus === undefined) return graph;
  // A non-numeric or absent depth means ONE hop: a focus view of depth zero is
  // a single node, which is never what someone asking to focus wants.
  const parsed = Number.parseInt(options.depth ?? "", 10);
  return focusSubgraph(graph, options.focus, Number.isFinite(parsed) && parsed > 0 ? parsed : 1);
}

/** The canvas filename for this run: the whole map, or the focused one. */
function canvasName(options: VisualizeOptions): string {
  if (options.focus === undefined) return "knowledge-map.canvas";
  return `${options.focus.replace(/[^A-Za-z0-9-]/g, "-")}.canvas`;
}

/** Report one artifact's disposition in the operator's terms. */
function reportWrite(result: ArtifactWriteResultV1): void {
  if (result.outcome === "created") {
    output.status("✓", output.success(`wrote ${result.file}`));
    return;
  }
  output.status("i", output.dim(`kept your existing ${result.file} — delete it to regenerate`));
}

/**
 * Regenerate the navigation artifacts. Returns the exit code.
 *
 * @param root - Project root to read and write under.
 * @param options - `--focus`, `--depth`.
 */
export default async function visualizeCommand(
  root: string, options: VisualizeOptions = {},
): Promise<number> {
  output.header("Regenerating navigation artifacts");
  const snapshot = await buildViewerSnapshot(root);
  const graph = selectedGraph(snapshot.graph, options);
  if (options.focus !== undefined && graph.nodes.length === 0) {
    output.status("!", output.error(`no node named ${options.focus} — nothing to focus on`));
    return 1;
  }
  const entityTypes = await declaredEntityTypes(root);
  reportWrite(await writeDerivedArtifact(
    root, OBSIDIAN_CONFIG, `${JSON.stringify(obsidianGraphConfig(entityTypes), null, 2)}\n`));
  reportWrite(await writeDerivedArtifact(
    root, path.join(CANVAS_DIR, canvasName(options)),
    `${JSON.stringify(canvasDocument(graph), null, 2)}\n`));
  output.status("i", output.dim(
    `${graph.nodes.length} node(s), ${graph.edges.length} edge(s). `
    + "Explore interactively with: llmwiki view"));
  return 0;
}

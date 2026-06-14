/**
 * Commander action for `llmwiki export [--target <name>]`.
 *
 * Transforms existing wiki content into portable export artifacts and writes
 * them into dist/exports/ (relative to the project root). Supports six formats:
 *
 *   llms-txt      — concise index per llmstxt.org spec → llms.txt
 *   llms-full-txt — full content export               → llms-full.txt
 *   json          — pages + metadata as JSON          → wiki.json
 *   json-ld       — Schema.org JSON-LD graph          → wiki.jsonld
 *   graphml       — directed link graph as XML        → wiki.graphml
 *   marp          — Marp slide deck                   → wiki.md
 *
 * No LLM calls are made — export is a pure transformation of wiki content.
 */

import path from "path";
import { createRequire } from "module";
import { atomicWrite } from "../utils/markdown.js";
import * as output from "../utils/output.js";
import { collectExportPages } from "../export/collect.js";
import { buildLlmsTxt, buildLlmsFullTxt } from "../export/llms-txt.js";
import {
  buildJsonExport,
  buildJsonExportDocument,
  type BuildJsonExportOptions,
  type JsonExportDocument,
} from "../export/json-export.js";
import { validateProjectId } from "../export/project-id.js";
import { buildJsonLd } from "../export/json-ld.js";
import { buildGraphml } from "../export/graphml.js";
import { buildMarp } from "../export/marp.js";
import { buildOkfBundle } from "../export/okf/bundle.js";
import { EXPORT_TARGETS, MARP_SOURCES } from "../export/types.js";
import type { ExportPage, ExportTarget, MarpSource } from "../export/types.js";

const require = createRequire(import.meta.url);

/** Output paths relative to dist/exports/ within the project root. */
const EXPORT_DIR = "dist/exports";

/** Map each target to its output filename. */
const TARGET_FILENAMES: Record<ExportTarget, string> = {
  "llms-txt": "llms.txt",
  "llms-full-txt": "llms-full.txt",
  json: "wiki.json",
  "json-ld": "wiki.jsonld",
  graphml: "wiki.graphml",
  marp: "wiki.md",
  // okf is a directory target; this entry satisfies the exhaustive Record type
  // but is never accessed (the OKF branch continues before reaching it).
  okf: "okf",
};

/** Options accepted by exportCommand and its programmatic entry point. */
export interface ExportOptions {
  /** Limit export to a single target. When absent all targets are produced. */
  target?: string;
  /**
   * For the marp target: which page kinds to include.
   * Accepts "concepts", "queries", or "all" (default when absent).
   */
  source?: string;
  /**
   * Optional bridge identifier embedded in the JSON export envelope.
   * Validated against the bridge contract regex
   * (`/^[a-z0-9][a-z0-9-]{0,62}$/`); invalid values throw before any
   * file is written.
   */
  projectId?: string;
  /**
   * Output directory for directory-style targets (e.g. okf).
   * When absent defaults to `dist/exports/okf` relative to the project root.
   */
  out?: string;
}

/** Result returned by runExport for testing and MCP consumers. */
export interface ExportResult {
  /** Absolute paths of files that were written. */
  written: string[];
  /** Number of pages included in each export. */
  pageCount: number;
}

/** Resolve the human-readable project title from package.json, defaulting gracefully. */
function resolveProjectTitle(root: string): string {
  try {
    const pkg = require(path.join(root, "package.json")) as { name?: string };
    return typeof pkg.name === "string" ? pkg.name : "Knowledge Wiki";
  } catch {
    return "Knowledge Wiki";
  }
}

/** Return true when the given string is a valid ExportTarget. */
function isValidTarget(value: string): value is ExportTarget {
  return (EXPORT_TARGETS as readonly string[]).includes(value);
}

/** Return true when the given string is a valid MarpSource. */
function isValidMarpSource(value: string): value is MarpSource {
  return (MARP_SOURCES as readonly string[]).includes(value);
}

/** Resolve and validate the marp source filter. Throws for unknown values. */
function resolveMarpSource(rawSource: string | undefined): MarpSource {
  if (!rawSource) return "all";
  if (!isValidMarpSource(rawSource)) {
    throw new Error(
      `Unknown --source value "${rawSource}". Valid values: ${MARP_SOURCES.join(", ")}`,
    );
  }
  return rawSource;
}

/** Inputs to {@link buildContent}. Grouped to keep the argument list short. */
interface BuildContentInputs {
  target: ExportTarget;
  pages: ExportPage[];
  projectTitle: string;
  marpSource: MarpSource;
  /** Optional bridge identifier; only consumed by the json target. */
  projectId?: string;
}

/** Build the content string for a single target. */
function buildContent(inputs: BuildContentInputs): string {
  const { target, pages, projectTitle, marpSource, projectId } = inputs;
  switch (target) {
    case "llms-txt":
      return buildLlmsTxt(pages, projectTitle);
    case "llms-full-txt":
      return buildLlmsFullTxt(pages, projectTitle);
    case "json":
      return buildJsonExport(pages, projectId !== undefined ? { projectId } : {});
    case "json-ld":
      return buildJsonLd(pages);
    case "graphml":
      return buildGraphml(pages);
    case "marp":
      return buildMarp(pages, projectTitle, marpSource);
    case "okf":
      // OKF is a directory target dispatched before buildContent is called.
      throw new Error("buildContent called for okf — this is a programming error");
  }
}

/**
 * Compute the page count to report in the CLI summary. When marp is the
 * only target and --source narrows the deck, report the filtered count so
 * the summary doesn't overstate what was exported. Multi-target runs keep
 * the collected total because non-marp targets always include every page.
 */
function computeReportedPageCount(
  pages: ExportPage[],
  targets: ExportTarget[],
  marpSource: MarpSource,
): number {
  const onlyMarpTarget = targets.length === 1 && targets[0] === "marp";
  if (onlyMarpTarget && marpSource !== "all") {
    return pages.filter((p) => p.pageDirectory === marpSource).length;
  }
  return pages.length;
}

/**
 * Programmatic entry point for the export pipeline.
 * @param root - Absolute path to the project root directory.
 * @param options - Export options (optional target filter).
 * @returns Paths written and page count.
 */
export async function runExport(root: string, options: ExportOptions = {}): Promise<ExportResult> {
  const projectId =
    options.projectId !== undefined ? validateProjectId(options.projectId) : undefined;
  const pages = await collectExportPages(root);
  const projectTitle = resolveProjectTitle(root);

  const targets = resolveTargets(options.target);
  const marpSource = resolveMarpSource(options.source);
  const written: string[] = [];

  for (const target of targets) {
    if (target === "okf") {
      const outDir = options.out ?? path.join(root, EXPORT_DIR, "okf");
      const writtenPaths = await buildOkfBundle(root, pages, outDir);
      written.push(...writtenPaths);
      output.status("+", output.success(`Exported okf bundle → ${output.source(outDir)}`));
      continue;
    }
    const content = buildContent({ target, pages, projectTitle, marpSource, projectId });
    const outPath = path.join(root, EXPORT_DIR, TARGET_FILENAMES[target]);
    await atomicWrite(outPath, content);
    written.push(outPath);
    output.status("+", output.success(`Exported ${target} → ${output.source(outPath)}`));
  }

  return { written, pageCount: computeReportedPageCount(pages, targets, marpSource) };
}

/**
 * Resolve the list of targets to run.
 * When a specific target is given it is validated; an error is thrown for unknown values.
 * Defaults to all targets.
 */
function resolveTargets(rawTarget: string | undefined): ExportTarget[] {
  if (!rawTarget) return [...EXPORT_TARGETS];

  if (!isValidTarget(rawTarget)) {
    throw new Error(
      `Unknown export target "${rawTarget}". Valid targets: ${EXPORT_TARGETS.join(", ")}`,
    );
  }

  return [rawTarget];
}

/**
 * Pure in-memory entry point — collects pages and returns the export document
 * object without writing any files or emitting console output.
 * @param root - Absolute path to the project root directory.
 * @param options - Optional export options (e.g. `projectId`).
 * @returns The JsonExportDocument object ready for programmatic consumption.
 */
export async function exportJson(
  root: string,
  options: BuildJsonExportOptions = {},
): Promise<JsonExportDocument> {
  const pages = await collectExportPages(root);
  return buildJsonExportDocument(pages, options);
}

/**
 * CLI action for `llmwiki export`.
 * @param root - Project root directory (defaults to cwd).
 * @param options - Commander-parsed options.
 */
export default async function exportCommand(
  root: string,
  options: ExportOptions,
): Promise<void> {
  output.header("Exporting wiki");
  const { written, pageCount } = await runExport(root, options);
  output.status(
    "✓",
    output.success(`Done — ${pageCount} pages exported to ${written.length} file(s).`),
  );
}

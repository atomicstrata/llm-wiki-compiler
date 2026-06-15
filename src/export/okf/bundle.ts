/**
 * @file Assemble + write the OKF bundle directory (path-confined).
 *
 * Orchestrates the full export: clears stale managed paths, writes index.md,
 * one doc per page under its pageDirectory/, copies cited source files into
 * references/, and appends a translated log.md. Every write is confined to
 * the bundle output directory; slugs that would escape it are rejected.
 */
import { mkdir, copyFile, rm, readFile } from "fs/promises";
import path from "path";
import { atomicWrite } from "../../utils/markdown.js";
import * as output from "../../utils/output.js";
import { safeRealpath, isInsideDir } from "../../utils/path-confine.js";
import type { ExportPage } from "../types.js";
import type { LinkResolver } from "./types.js";
import { renderOkfDoc } from "./render-doc.js";
import { buildOkfIndex, buildOkfLog, parseLlmwikiLog } from "./index-log.js";
import { collectReferenceFiles, resolveReferences, type ResolvedReference } from "./references.js";
import { resolveOutputPaths } from "./output-paths.js";

/** A resolver over the export's own pages (title + resolved output path per slug). */
function makeResolver(pages: ExportPage[], paths: Map<ExportPage, string>): LinkResolver {
  const map = new Map(pages.map((p) => [p.slug, { path: paths.get(p)!, title: p.title }] as const));
  return (slug) => map.get(slug) ?? null;
}

/**
 * Write `rel` (a bundle-relative path) under `out`, confined; returns the abs path.
 * Throws when the normalized destination escapes the bundle directory.
 */
async function writeConfined(out: string, rel: string, content: string): Promise<string> {
  const normalized = path.normalize(path.join(out, rel));
  if (!isInsideDir(normalized, out)) throw new Error(`OKF write escapes bundle: ${rel}`);
  await atomicWrite(normalized, content);
  return normalized;
}

/** OKF-managed paths cleared before each export so deleted pages don't linger. */
async function clearOkfManaged(realOut: string): Promise<void> {
  for (const rel of ["concepts", "queries", "references", "index.md", "log.md"]) {
    await rm(path.join(realOut, rel), { recursive: true, force: true });
  }
}

/** OKF log translated from llmwiki's activity log.md when present, else a synthetic export entry. */
async function buildLog(root: string, pageCount: number): Promise<string> {
  const fallback = [{ date: new Date().toISOString().slice(0, 10), action: "Export", text: `${pageCount} doc(s)` }];
  const llmwikiLog = await readFile(path.join(root, "log.md"), "utf-8").catch(() => null);
  const parsed = llmwikiLog ? parseLlmwikiLog(llmwikiLog) : [];
  return buildOkfLog(parsed.length ? parsed : fallback);
}

/** Copy the already-resolved references into references/, confined to the bundle. */
async function copyResolvedReferences(
  refs: Map<string, ResolvedReference>,
  realOut: string,
): Promise<string[]> {
  const written: string[] = [];
  for (const { srcAbs, destName } of refs.values()) {
    const dest = path.join(realOut, "references", destName);
    if (!isInsideDir(path.normalize(dest), realOut)) continue;
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(srcAbs, dest);
    written.push(dest);
  }
  return written;
}

/** Surface cited sources that were not bundled (missing or outside sources/) via the warning collector. */
function reportSkippedReferences(
  pages: ExportPage[],
  refs: Map<string, ResolvedReference>,
  onWarn: (msg: string) => void,
): void {
  const skipped = collectReferenceFiles(pages).filter((f) => !refs.has(f));
  if (skipped.length === 0) return;
  onWarn(`OKF export: ${skipped.length} cited source(s) not bundled (missing or outside sources/)`);
}

/**
 * Build the full OKF bundle at `out`. Returns the list of written file paths.
 *
 * @param root - llmwiki project root (sources/ lives here).
 * @param pages - All export pages to include in this bundle.
 * @param out - Destination directory for the OKF bundle (created if absent).
 * @param onWarn - Collector for non-fatal warnings (e.g. cited sources not bundled).
 *   Defaults to printing via `output.status` so direct callers are unchanged; the
 *   output-free core (`runOkfExport`) passes a collector so nothing reaches stdout.
 * @returns Absolute paths of every file written (index, docs, references, log).
 */
export async function buildOkfBundle(
  root: string,
  pages: ExportPage[],
  out: string,
  onWarn: (msg: string) => void = (m) => output.status("!", output.warn(m)),
): Promise<string[]> {
  await mkdir(out, { recursive: true });
  const realOut = (await safeRealpath(out)) ?? path.normalize(out);
  await clearOkfManaged(realOut);
  const { paths, warnings: pathWarnings } = resolveOutputPaths(pages, realOut);
  const resolve = makeResolver(pages, paths);
  // Resolve references FIRST so citation links are emitted only for files actually copied.
  const refs = await resolveReferences(root, pages);
  const refName = (file: string): string | null => refs.get(file)?.destName ?? null;
  const written: string[] = [];

  written.push(await writeConfined(realOut, "index.md", buildOkfIndex(pages, paths)));
  for (const p of pages) {
    const docRel = paths.get(p)!;
    written.push(await writeConfined(realOut, docRel, renderOkfDoc(p, resolve, refName)));
  }
  written.push(...(await copyResolvedReferences(refs, realOut)));
  written.push(await writeConfined(realOut, "log.md", await buildLog(root, pages.length)));
  reportSkippedReferences(pages, refs, onWarn);
  for (const w of pathWarnings) onWarn(w);
  return written;
}

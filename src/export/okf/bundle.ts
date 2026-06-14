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
import { safeRealpath, isInsideDir } from "../../utils/path-confine.js";
import { SOURCES_DIR } from "../../utils/constants.js";
import type { ExportPage } from "../types.js";
import type { LinkResolver } from "./types.js";
import { safeRefName } from "./mapping.js";
import { renderOkfDoc } from "./render-doc.js";
import { buildOkfIndex, buildOkfLog, parseLlmwikiLog } from "./index-log.js";
import { collectReferenceFiles } from "./references.js";

/** A resolver over the export's own pages (title + dir per slug). */
function makeResolver(pages: ExportPage[]): LinkResolver {
  const map = new Map(
    pages.map((p) => [p.slug, { dir: p.pageDirectory, title: p.title }] as const),
  );
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

/** Write all cited source files into references/, path-confined on both ends. */
async function writeReferences(root: string, pages: ExportPage[], realOut: string): Promise<string[]> {
  const written: string[] = [];
  // Canonicalize sources dir so isInsideDir works correctly on macOS (/private/var/... vs /var/...).
  const sourcesDir = (await safeRealpath(path.join(root, SOURCES_DIR))) ?? path.join(root, SOURCES_DIR);
  for (const file of collectReferenceFiles(pages)) {
    const src = path.join(sourcesDir, file);
    const realSrc = await safeRealpath(src);
    if (!realSrc || !isInsideDir(realSrc, sourcesDir)) continue;
    const dest = path.join(realOut, "references", safeRefName(file));
    if (!isInsideDir(path.normalize(dest), realOut)) continue;
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(realSrc, dest);
    written.push(dest);
  }
  return written;
}

/**
 * Build the full OKF bundle at `out`. Returns the list of written file paths.
 *
 * @param root - llmwiki project root (sources/ lives here).
 * @param pages - All export pages to include in this bundle.
 * @param out - Destination directory for the OKF bundle (created if absent).
 * @returns Absolute paths of every file written (index, docs, references, log).
 */
export async function buildOkfBundle(root: string, pages: ExportPage[], out: string): Promise<string[]> {
  await mkdir(out, { recursive: true });
  const realOut = (await safeRealpath(out)) ?? path.normalize(out);
  await clearOkfManaged(realOut);
  const resolve = makeResolver(pages);
  const written: string[] = [];

  written.push(await writeConfined(realOut, "index.md", buildOkfIndex(pages)));
  for (const p of pages) {
    const docRel = `${p.pageDirectory}/${p.slug}.md`;
    const docAbs = path.normalize(path.join(realOut, docRel));
    const pageDir = path.join(realOut, p.pageDirectory);
    // Reject slugs with traversal components (e.g. "../escape") — the doc must stay in its pageDirectory.
    if (!isInsideDir(docAbs, pageDir)) throw new Error(`OKF page slug escapes its directory: ${p.slug}`);
    written.push(await writeConfined(realOut, docRel, renderOkfDoc(p, resolve)));
  }
  written.push(...(await writeReferences(root, pages, realOut)));
  written.push(await writeConfined(realOut, "log.md", await buildLog(root, pages.length)));
  return written;
}

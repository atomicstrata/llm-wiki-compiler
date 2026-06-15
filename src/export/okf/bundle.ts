/**
 * @file Assemble + write the OKF bundle directory (path-confined).
 *
 * Orchestrates the full export: refuses unsafe output dirs (project/fs root,
 * inside .git, non-empty non-bundle, nested .git), wholesale-clears a recognized
 * prior bundle, writes index.md, one doc per page at its resolved output path,
 * copies cited source files into references/, and appends a translated log.md.
 * Every write is realpath-confined to the bundle output directory.
 */
import { mkdir, copyFile, rm, readFile, readdir, lstat } from "fs/promises";
import path from "path";
import { atomicWrite, parseFrontmatterStatus } from "../../utils/markdown.js";
import * as output from "../../utils/output.js";
import { safeRealpath, isInsideDir, confineUnderRoot } from "../../utils/path-confine.js";
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
 * Write `rel` (a bundle-relative path) under `out`, realpath-confined; returns the abs path.
 * `confineUnderRoot` rejects any `rel` whose resolved target (or a symlinked parent) escapes `out`.
 */
async function writeConfined(out: string, rel: string, content: string): Promise<string> {
  const abs = await confineUnderRoot(rel, out, { mustExist: false });
  await atomicWrite(abs, content);
  return abs;
}

/** True if `p` exists (any type) without following a final symlink. */
async function lexists(p: string): Promise<boolean> {
  try { await lstat(p); return true; } catch { return false; }
}

/**
 * Realpath of the nearest EXISTING ancestor of `p`, plus the not-yet-existing suffix.
 * Resolves symlinked parents so a fresh `<root>/exports/okf` where `exports` -> elsewhere
 * yields the REAL location `mkdir` would create — not the lexical path.
 */
async function resolveRealTarget(p: string): Promise<string> {
  let cur = path.resolve(p);
  const suffix: string[] = [];
  for (;;) {
    const real = await safeRealpath(cur);
    if (real) return suffix.length ? path.join(real, ...suffix.reverse()) : real;
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p); // no existing ancestor
    suffix.push(path.basename(cur));
    cur = parent;
  }
}

/**
 * PRE-mkdir refusal on the SYMLINK-RESOLVED target (must run BEFORE the dir is created).
 * Refuse the DANGEROUS resolved targets only: the filesystem root, the project root, or
 * inside `.git`. Resolving symlinked parents first is the point — `<root>/exports -> <root>/.git`
 * with `--out <root>/exports/okf` looks safe lexically but resolves into `.git` and is refused.
 * An out dir OUTSIDE the project root is ALLOWED: external export is a supported pattern.
 */
async function assertSafeBundleTarget(out: string, root: string): Promise<void> {
  const realRoot = (await safeRealpath(root)) ?? path.resolve(root);
  const target = await resolveRealTarget(out);
  if (target === path.parse(target).root) throw new Error("OKF export: refusing to export to the filesystem root");
  if (target === realRoot) throw new Error("OKF export: refusing to export to the project root");
  if (isInsideDir(target, path.join(realRoot, ".git"))) throw new Error("OKF export: refusing to export inside .git");
}

/** POST-mkdir refusal: an existing out dir that itself holds a top-level `.git` (a nested repo). */
async function assertNoTopLevelGit(realOut: string): Promise<void> {
  if (await lexists(path.join(realOut, ".git"))) throw new Error("OKF export: refusing to export to a directory containing .git");
}

/** True when `realOut` looks like a prior OKF bundle: root index.md is a regular file with okf_version frontmatter. */
async function isRecognizedBundle(realOut: string): Promise<boolean> {
  const idx = path.join(realOut, "index.md");
  try { if (!(await lstat(idx)).isFile()) return false; } catch { return false; }
  const { meta } = parseFrontmatterStatus(await readFile(idx, "utf-8"));
  return typeof meta.okf_version !== "undefined";
}

/** Throw if any `.git` entry exists anywhere under `realOut` (lstat, no symlink-follow). */
async function assertNoNestedGit(realOut: string): Promise<void> {
  for (const e of await readdir(realOut, { withFileTypes: true })) {
    if (e.name === ".git") throw new Error(`OKF export: refusing to clear ${realOut} — it contains a nested .git`);
    if (e.isDirectory()) await assertNoNestedGit(path.join(realOut, e.name));
  }
}

/** Remove every child of `realOut` (the dir itself stays). */
async function clearContents(realOut: string): Promise<void> {
  for (const name of await readdir(realOut)) await rm(path.join(realOut, name), { recursive: true, force: true });
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
    const dest = await confineUnderRoot(path.join("references", destName), realOut, { mustExist: false });
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
  await assertSafeBundleTarget(out, root);           // BEFORE any write — resolved target inside root, not root/.git/fs-root
  await mkdir(out, { recursive: true });
  const realOut = (await safeRealpath(out)) ?? path.normalize(out);
  await assertNoTopLevelGit(realOut);                // existing dir holding a top-level .git (mkdir of an existing dir is a no-op)
  const empty = (await readdir(realOut)).length === 0;
  const bundle = empty ? false : await isRecognizedBundle(realOut);
  if (!empty && !bundle) throw new Error(`OKF export: ${out} is not empty and not an OKF bundle; export into a fresh directory or an existing OKF bundle.`);
  if (bundle) { await assertNoNestedGit(realOut); await clearContents(realOut); }
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

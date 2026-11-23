/**
 * @file Assemble + write the OKF bundle directory (path-confined).
 *
 * Orchestrates the full export: refuses unsafe output dirs (project/fs root,
 * inside .git, non-empty non-bundle, nested .git), wholesale-clears a recognized
 * prior bundle, writes index.md, one doc per page at its resolved output path,
 * copies cited source files into references/, and appends a translated log.md.
 * Every write is realpath-confined to the bundle output directory.
 *
 * ONE BODY, {@link buildOkfBundleFrom}, over {@link OkfBundleSources}: the
 * bundle's own path operations ({@link OkfBundleTree}) plus the existing
 * profile, entity-scan, graph and workflow-run reads. Every decision (the
 * refusals and their order, the bundle recognition, the nested `.git` scan, the
 * clear, the output paths, which references are copied, the profile surfaces,
 * the log, every write and every warning) is the body's. The path operations
 * are the local disk's named mechanisms, unchanged: real-path lookup,
 * no-follow kind, directory listing and creation, forced removal, root
 * confinement, the atomic writer and the byte copy. The output directory may
 * be OUTSIDE the project; this binding names host paths for this one export
 * and is not `ProjectStore`, a hosted store or an access-control layer.
 */
import path from "path";
import { copyLocationBytes, removeTreeForced } from "../../storage/disk-bundle-tree.js";
import { listDirectoryEntries, listDirectoryNames, makeDirectoryTree } from "../../storage/disk-guarded-leaves.js";
import { diskLocalEntityScans, locationKindNoFollow } from "../../storage/disk-local-reads.js";
import { readLocationText } from "../../storage/disk-locations.js";
import type { LegacyLocalEntityScans, LocalEntryKind } from "../../storage/legacy-local-reads.js";
import { atomicWrite, parseFrontmatterStatus } from "../../utils/markdown.js";
import * as output from "../../utils/output.js";
import { safeRealpath, isInsideDir, confineUnderRoot } from "../../utils/path-confine.js";
import { diskRelationGraphReads } from "../../relations/graph-reads.js";
import { diskWorkflowRunReads } from "../../workflow-history/store.js";
import type { ExportPage } from "../types.js";
import type { LinkResolver } from "./types.js";
import { renderOkfDoc } from "./render-doc.js";
import { buildOkfIndex, buildOkfLog, parseLlmwikiLog } from "./index-log.js";
import { collectReferenceFiles, resolveReferencesFrom, type ResolvedReference } from "./references.js";
import { resolveOutputPaths } from "./output-paths.js";
import { collectProfileEntityDocsFrom } from "./profile-docs.js";
import { collectBundleBlockFrom, type BundleBlockSources } from "./bundle-block.js";
import { diskEffectiveProfileSources, type EffectiveProfileSources } from "../../profile/load.js";
import { loadNonDefaultProfileFrom } from "../../profile/block.js";

/** OS noise files that must not, by themselves, make an output dir count as non-empty. */
const IGNORED_DIR_ENTRIES = new Set([".DS_Store", "Thumbs.db"]);

/**
 * The path operations the bundle performs, each on a path the body names. A
 * NARROW, export-specific seam: no member decides anything; each one answers
 * or acts exactly as its disk mechanism does.
 */
export interface OkfBundleTree {
  /** The real path, or `null` when the location does not resolve. */
  realpath(location: string): Promise<string | null>;
  /** The kind of entry, without following a final link. REJECTS when absent. */
  kindNoFollow(location: string): Promise<LocalEntryKind>;
  /** A file's whole text. REJECTS raw. */
  readText(location: string): Promise<string>;
  /** A directory's entry names. REJECTS raw. */
  listNames(dir: string): Promise<string[]>;
  /** A directory's entries with whether each is a directory. REJECTS raw. */
  listEntries(dir: string): Promise<Array<{ name: string; isDirectory(): boolean }>>;
  /** Create a directory and its missing parents; an existing one is left alone. */
  makeTree(dir: string): Promise<void>;
  /** DESTROYS an entry and everything under it; a missing entry is not an error. */
  removeTree(location: string): Promise<void>;
  /** The absolute form of `rel` under `root`, or THROWS when it (or a linked parent) escapes. */
  confine(rel: string, root: string): Promise<string>;
  /** Write a file atomically, creating its parent directories. */
  write(location: string, content: string): Promise<void>;
  /** Copy a file's bytes, undecoded; an existing destination is overwritten. */
  copyBytes(from: string, to: string): Promise<void>;
}

/** Everything {@link buildOkfBundleFrom} reads and writes through. Production builds all from one root. */
export interface OkfBundleSources {
  tree: OkfBundleTree;
  /** The effective profile, loaded ONCE and threaded to every profile-aware surface. */
  profile: EffectiveProfileSources;
  /** The entity directories, for the profile's entity documents. */
  scans: LegacyLocalEntityScans;
  /** The relation and workflow-run reads, for the bundle block. */
  block: BundleBlockSources;
}

/** LOCAL DISK. The path operations, each the named disk mechanism the export always used. Holds no path. */
const DISK_OKF_BUNDLE_TREE: OkfBundleTree = {
  realpath: (location) => safeRealpath(location),
  kindNoFollow: locationKindNoFollow,
  readText: readLocationText,
  listNames: listDirectoryNames,
  listEntries: listDirectoryEntries,
  makeTree: makeDirectoryTree,
  removeTree: removeTreeForced,
  confine: (rel, root) => confineUnderRoot(rel, root, { mustExist: false }),
  write: (location, content) => atomicWrite(location, content),
  copyBytes: copyLocationBytes,
};

/** LOCAL DISK. The bundle sources for the project at `root`. Building them does no I/O. In no package index; exported for the OKF export core only. */
export function diskOkfBundleSources(root: string): OkfBundleSources {
  return {
    tree: DISK_OKF_BUNDLE_TREE,
    profile: diskEffectiveProfileSources(root),
    scans: diskLocalEntityScans(root),
    block: { graph: diskRelationGraphReads(root), runs: diskWorkflowRunReads(root) },
  };
}

/** A resolver over the export's own pages (title + resolved output path per slug). */
function makeResolver(pages: ExportPage[], paths: Map<ExportPage, string>): LinkResolver {
  const map = new Map(pages.map((p) => [p.slug, { path: paths.get(p)!, title: p.title }] as const));
  return (slug) => map.get(slug) ?? null;
}

/**
 * Write `rel` (a bundle-relative path) under `out`, realpath-confined; returns the abs path.
 * `confine` rejects any `rel` whose resolved target (or a symlinked parent) escapes `out`.
 * A realpath escape here ABORTS the export (a hard backstop) rather than silently falling back —
 * unreachable in practice because the wholesale-clear strips bundle symlinks before any write.
 */
async function writeConfined(tree: OkfBundleTree, out: string, rel: string, content: string): Promise<string> {
  const abs = await tree.confine(rel, out);
  await tree.write(abs, content);
  return abs;
}

/** True if `p` exists (any type) without following a final symlink. */
async function lexists(tree: OkfBundleTree, p: string): Promise<boolean> {
  try { await tree.kindNoFollow(p); return true; } catch { return false; }
}

/**
 * Realpath of the nearest EXISTING ancestor of `p`, plus the not-yet-existing suffix.
 * Resolves symlinked parents so a fresh `<root>/exports/okf` where `exports` -> elsewhere
 * yields the REAL location `mkdir` would create — not the lexical path.
 */
async function resolveRealTarget(tree: OkfBundleTree, p: string): Promise<string> {
  let cur = path.resolve(p);
  const suffix: string[] = [];
  for (;;) {
    const real = await tree.realpath(cur);
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
async function assertSafeBundleTarget(tree: OkfBundleTree, out: string, root: string): Promise<void> {
  const realRoot = (await tree.realpath(root)) ?? path.resolve(root);
  const target = await resolveRealTarget(tree, out);
  if (target === path.parse(target).root) throw new Error("OKF export: refusing to export to the filesystem root");
  if (target === realRoot) throw new Error("OKF export: refusing to export to the project root");
  if (isInsideDir(target, path.join(realRoot, ".git"))) throw new Error("OKF export: refusing to export inside .git");
}

/** POST-mkdir refusal: an existing out dir that itself holds a top-level `.git` (a nested repo). */
async function assertNoTopLevelGit(tree: OkfBundleTree, realOut: string): Promise<void> {
  if (await lexists(tree, path.join(realOut, ".git"))) throw new Error("OKF export: refusing to export to a directory containing .git");
}

/** True when `realOut` looks like a prior OKF bundle: root index.md is a regular file with okf_version frontmatter. */
async function isRecognizedBundle(tree: OkfBundleTree, realOut: string): Promise<boolean> {
  const idx = path.join(realOut, "index.md");
  try { if ((await tree.kindNoFollow(idx)) !== "file") return false; } catch { return false; }
  const { meta } = parseFrontmatterStatus(await tree.readText(idx));
  return typeof meta.okf_version !== "undefined";
}

/**
 * Throw if any `.git` entry exists anywhere under `realOut` (lstat, no symlink-follow).
 * A full recursive scan bounded by bundle size, run once before clearing a recognized bundle.
 */
async function assertNoNestedGit(tree: OkfBundleTree, realOut: string): Promise<void> {
  for (const e of await tree.listEntries(realOut)) {
    if (e.name === ".git") throw new Error(`OKF export: refusing to clear ${realOut} — it contains a nested .git`);
    if (e.isDirectory()) await assertNoNestedGit(tree, path.join(realOut, e.name));
  }
}

/** Remove every child of `realOut` (the dir itself stays). */
async function clearContents(tree: OkfBundleTree, realOut: string): Promise<void> {
  for (const name of await tree.listNames(realOut)) await tree.removeTree(path.join(realOut, name));
}

/** OKF log translated from llmwiki's activity log.md when present, else a synthetic export entry. */
async function buildLog(tree: OkfBundleTree, root: string, pageCount: number): Promise<string> {
  const fallback = [{ date: new Date().toISOString().slice(0, 10), action: "Export", text: `${pageCount} doc(s)` }];
  const llmwikiLog = await tree.readText(path.join(root, "log.md")).catch(() => null);
  const parsed = llmwikiLog ? parseLlmwikiLog(llmwikiLog) : [];
  return buildOkfLog(parsed.length ? parsed : fallback);
}

/** Copy the already-resolved references into references/, confined to the bundle. */
async function copyResolvedReferences(
  tree: OkfBundleTree,
  refs: Map<string, ResolvedReference>,
  realOut: string,
): Promise<string[]> {
  const written: string[] = [];
  for (const { srcAbs, destName } of refs.values()) {
    const dest = await tree.confine(path.join("references", destName), realOut);
    await tree.makeTree(path.dirname(dest));
    await tree.copyBytes(srcAbs, dest);
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
 * Refuse a dangerous target, create the output dir, then refuse a nested repo or a foreign
 * non-empty dir, and clear a recognized prior bundle. Returns the real output dir.
 */
async function prepareOutputDir(tree: OkfBundleTree, root: string, out: string): Promise<string> {
  await assertSafeBundleTarget(tree, out, root);     // BEFORE any write — refuse fs-root, project-root, inside-.git on the resolved target (external out is allowed)
  await tree.makeTree(out);
  const realOut = (await tree.realpath(out)) ?? path.normalize(out);
  await assertNoTopLevelGit(tree, realOut);          // existing dir holding a top-level .git (mkdir of an existing dir is a no-op)
  const empty = (await tree.listNames(realOut)).filter((e) => !IGNORED_DIR_ENTRIES.has(e)).length === 0;
  const bundle = empty ? false : await isRecognizedBundle(tree, realOut);
  if (!empty && !bundle) throw new Error(`OKF export: ${out} is not empty and not an OKF bundle; export into a fresh directory or an existing OKF bundle.`);
  if (bundle) { await assertNoNestedGit(tree, realOut); await clearContents(tree, realOut); }
  return realOut;
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
  // `async` so that a throw while the disk sources are built REJECTS.
  return buildOkfBundleFrom(diskOkfBundleSources(root), root, pages, out, onWarn);
}

/**
 * {@link buildOkfBundle} over {@link OkfBundleSources}: THE ONE BODY. One step after
 * another: the output dir's refusals, creation and clear; the output paths; the
 * references; the profile, its entity docs and its bundle block; then index.md, each
 * page doc, each entity doc, the references, log.md, and the warnings last.
 */
export async function buildOkfBundleFrom(
  sources: OkfBundleSources,
  root: string,
  pages: ExportPage[],
  out: string,
  onWarn: (msg: string) => void,
): Promise<string[]> {
  const { tree } = sources;
  const realOut = await prepareOutputDir(tree, root, out);
  const { paths, warnings: pathWarnings } = resolveOutputPaths(pages, realOut);
  const resolve = makeResolver(pages, paths);
  // Resolve references FIRST so citation links are emitted only for files actually copied.
  const refs = await resolveReferencesFrom((location) => tree.realpath(location), root, pages);
  const refName = (file: string): string | null => refs.get(file)?.destName ?? null;
  // Load the ACTIVE profile ONCE and thread it to every profile-aware surface, so
  // the export validates it a single time and all surfaces see the same profile.
  // `undefined` = the built-in default: entity docs are [] and the bundle block is
  // omitted, so the bundle stays byte-identical to a pre-7.6 export (D-7.6.10).
  const loaded = await loadNonDefaultProfileFrom(sources.profile);
  // Entity-page bodies reuse the native-page resolver for wikilink rewriting.
  const entityDocs = await collectProfileEntityDocsFrom(sources.scans, resolve, loaded);
  const bundleBlock = await collectBundleBlockFrom(sources.block, loaded);
  const written: string[] = [];

  written.push(await writeConfined(tree, realOut, "index.md", buildOkfIndex(pages, paths, entityDocs, bundleBlock)));
  for (const p of pages) {
    const docRel = paths.get(p)!;
    written.push(await writeConfined(tree, realOut, docRel, renderOkfDoc(p, resolve, refName)));
  }
  for (const doc of entityDocs) {
    written.push(await writeConfined(tree, realOut, doc.rel, doc.content));
  }
  written.push(...(await copyResolvedReferences(tree, refs, realOut)));
  written.push(await writeConfined(tree, realOut, "log.md", await buildLog(tree, root, pages.length)));
  reportSkippedReferences(pages, refs, onWarn);
  for (const w of pathWarnings) onWarn(w);
  return written;
}

/**
 * Confined wiki-read helpers for the compile path.
 *
 * Today compile reads wiki files (index.md, concept/query pages) through
 * `safeReadFile`, which FOLLOWS symlinks: a symlinked `wiki/concepts/foo.md →
 * /etc/passwd` would be read and re-emitted into a planned write or an LLM
 * prompt. These helpers replace that trust property with EXACT-directory
 * confinement plus a handle-bound, no-follow read.
 *
 * Both exports resolve the canonical root, derive the EXACT expected directory,
 * confine the exact file under it (`safeRealpath` + `isInsideDir`), then read
 * the bytes through `readConfinedPage` — which binds the returned bytes to
 * the OPENED HANDLE's `{dev,ino}` (TOCTOU-safe, never re-opens the path). This
 * mirrors the resolve pattern in `../utils/page-registry.ts`.
 *
 * Both return a discriminated `{ content } | { dropped }`. A `dropped` result
 * carries a short machine-readable reason and — critically — NEVER carries the
 * escaping target's bytes: when the path escapes its expected directory the
 * function returns `{ dropped: "escapes-dir" }` before any read occurs, so no
 * out-of-tree content can leak into a planned write or an LLM prompt.
 *
 * CONTRACT (user-facing): a wiki file's content must resolve UNDER the project
 * root. A wiki file that is a symlink whose target escapes the project root is
 * UNSUPPORTED — it is DROPPED (never read, never re-emitted, never sent to an
 * LLM provider) and its escaping relative path is NAMED in a prominent warning
 * via {@link warnDroppedWikiRead}. An escaping symlink is never silently followed.
 */

import path from "path";
import { leafPresent } from "../storage/disk-guarded-leaves.js";
import { diskLocalReads, readConfinedExactFile } from "../storage/disk-local-reads.js";
import type { ConfinedReadResult, LegacyLocalReads } from "../storage/legacy-local-reads.js";
import { safeRealpath } from "../utils/path-confine.js";
import * as output from "../utils/output.js";

export type { ConfinedReadResult };

/**
 * Emit a PROMINENT, tamper-grade warning that a wiki read was dropped, NAMING
 * the escaping relative path. Compile read sites call this on a `{dropped}`
 * result before skipping the file, so a symlink-escaping wiki file surfaces
 * with the same gravity as a tamper signal — never a silent shrug. Uses the
 * `!` status icon + the yellow `warn` channel (not a dim detail line).
 *
 * @param relPath - The project-relative wiki path that was dropped (named in
 *   the message so an operator can locate and remove the offending symlink).
 * @param reason - The machine-readable drop reason from {@link ConfinedReadResult}.
 */
export function warnDroppedWikiRead(relPath: string, reason: string): void {
  output.status(
    "!",
    output.warn(
      `Dropped wiki read (${reason}): ${relPath} — its content does not resolve under the project root and was NOT read or re-emitted.`,
    ),
  );
}

/**
 * Warn about a dropped wiki read ONLY when the file PHYSICALLY exists. For
 * call sites where a legitimately-ABSENT file shares the `escapes-dir` drop
 * reason (e.g. a brand-new page being generated), a silent skip is correct —
 * but a file that physically exists yet was dropped is a real escape/tamper and
 * MUST surface prominently. The `lstat` is no-follow, so an escaping SYMLINK is
 * detected as present (it is the symlink that exists, not its target).
 *
 * @param absPath - Absolute path of the wiki file that was dropped. It must be a
 *   `path.join` result that ENDS IN A FILE NAME, as every caller passes: the
 *   presence test splits it into parent and name, which is the identity only
 *   for such a path (not for a trailing separator or an empty string).
 * @param relPath - Project-relative path to name in the warning.
 * @param reason - The machine-readable drop reason.
 */
export async function warnDroppedWikiReadIfPresent(
  absPath: string,
  relPath: string,
  reason: string,
): Promise<void> {
  const exists = await leafPresent(path.dirname(absPath), path.basename(absPath)).catch(() => false);
  if (exists) warnDroppedWikiRead(relPath, reason);
}

/**
 * Read one wiki page confined to `<root>/<relDir>` and reduce the discriminated
 * result to a plain string for the common "fold-into-prompt/body" call sites.
 * On `{content}` returns the bytes; on a drop returns `""` and warns.
 *
 * `warnAlways` (default `true`) controls the drop-warning policy — see
 * {@link readWikiPageOrWarn} for the full semantics.
 *
 * Centralizing this here keeps every compile read site (page-renderer, seed,
 * resolver, indexgen, MOC) on ONE confine+drop+warn primitive.
 *
 * @param root - Project root the page must resolve under.
 * @param relDir - Project-relative directory the page must stay inside.
 * @param slug - Page slug (`<slug>.md` is read under `relDir`).
 * @param warnAlways - See {@link readWikiPageOrWarn}.
 * @returns The page bytes, or `""` when dropped.
 */
export function readWikiPageContentOrWarn(
  root: string,
  relDir: string,
  slug: string,
  warnAlways = true,
): Promise<string> {
  return readWikiPageContentOrWarnFrom(diskLocalReads(root), relDir, slug, warnAlways);
}

/** {@link readWikiPageContentOrWarn}, with the page read through `reads`. */
export async function readWikiPageContentOrWarnFrom(
  reads: LegacyLocalReads,
  relDir: string,
  slug: string,
  warnAlways = true,
): Promise<string> {
  const result = await readWikiPageOrWarn(reads, relDir, slug, warnAlways);
  return "content" in result ? result.content : "";
}

/**
 * {@link warnDroppedWikiReadIfPresent} for a project-relative path, with the
 * no-follow presence check made through `reads`. Any failure to stat means
 * "not present", exactly as the absolute-path form decides it.
 */
export async function warnDroppedReadIfPresentFrom(
  reads: LegacyLocalReads,
  statPath: string,
  relPath: string,
  reason: string,
): Promise<void> {
  const exists = await reads.statNoFollow(statPath).then(() => true, () => false);
  if (exists) warnDroppedWikiRead(relPath, reason);
}

/**
 * Like {@link readWikiPageContentOrWarn} but returns the discriminated
 * `{content}|{dropped}` so directory-SCAN callers can distinguish a genuinely
 * EMPTY page (`{content:""}` — still scanned for its slug) from a DROPPED one
 * (`{dropped}` — skipped). On a drop the warning is emitted here; the caller
 * only has to branch on `"content" in result`.
 *
 * `warnAlways` chooses the drop-warning policy:
 *  - `true` (default): warn on EVERY drop. Use at directory-SCAN sites where
 *    `readdir` already proved the entry exists, so any drop is a real escape.
 *  - `false`: absence is normal (a brand-new/seed page that shares the
 *    `escapes-dir` reason with a genuinely-missing file). Warn only when the
 *    file PHYSICALLY exists — an escaping symlink or a fail-closed read — via
 *    {@link warnDroppedWikiReadIfPresent}.
 *
 * @param reads - The project's read binding; the page must resolve under it.
 * @param relDir - Project-relative directory the page must stay inside.
 * @param slug - Page slug (`<slug>.md` is read under `relDir`).
 * @param warnAlways - Warn on every drop (scan sites), else only when present.
 * @returns The confined read result, after emitting any drop warning.
 */
async function readWikiPageOrWarn(
  reads: LegacyLocalReads,
  relDir: string,
  slug: string,
  warnAlways = true,
): Promise<ConfinedReadResult> {
  const result = await reads.readConfinedPage(relDir, slug);
  if ("content" in result) return result;
  const relPath = path.join(relDir, `${slug}.md`);
  if (warnAlways) warnDroppedWikiRead(relPath, result.dropped);
  else await warnDroppedReadIfPresentFrom(reads, path.join(relDir, path.basename(relPath)), relPath, result.dropped);
  return result;
}

/**
 * LOCAL DISK. A page reader confined to the EXACT absolute directory
 * `absScanDir` (the directory itself is the confinement boundary). The
 * directory's real path is looked up once, on the first read, and every read
 * of `<slug>.md` under it then goes through the shared realpath + isInsideDir
 * + handle-bound read flow. A directory that does not resolve is
 * `{dropped: "no-root"}`.
 *
 * One lookup per reader is safe: each read's post-open check re-resolves the
 * page path and requires it inside that canonical directory, bound to the
 * opened file, so a directory swapped mid-walk drops pages rather than
 * leaking them. Build one reader per walk.
 *
 * Used by the directory-SCAN sites, the page scan in `indexgen` and the
 * concept load in `obsidian`, which hold an absolute scan dir, not a
 * project-root + relative-dir pair.
 *
 * NO WARNING IS EMITTED HERE. The discriminated result keeps the
 * EMPTY-vs-DROPPED distinction, and the CALLER owns what a drop means and
 * reports it: both scan sites warn on every drop through
 * {@link warnDroppedWikiRead}, naming `<slug>.md`, since they iterate listed
 * entries that provably exist.
 *
 * @param absScanDir - Absolute directory every page must stay inside.
 * @returns A reader of `<slug>.md` under `absScanDir`, emitting no warning.
 */
export function wikiPageReaderInDir(absScanDir: string): (slug: string) => Promise<ConfinedReadResult> {
  let canonicalDir: Promise<string | null> | undefined;
  return async (slug) => {
    const dir = await (canonicalDir ??= safeRealpath(absScanDir));
    if (!dir) return { dropped: "no-root" };
    return readConfinedExactFile(dir, path.join(dir, `${slug}.md`));
  };
}

/**
 * Read a wiki page confined to its EXACT expected directory. The file
 * `<root>/<relDir>/<slug>.md` is resolved, and a symlink whose realpath escapes
 * `<root>/<relDir>` is DROPPED — its target is never read or emitted. The body
 * is read through the binding's handle-bound reader, so the no-follow handle-bound read
 * also defeats a TOCTOU parent-directory swap.
 *
 * @param root - Project root path (raw; canonicalized internally via realpath).
 * @param relDir - Project-relative directory the page must stay inside
 *   (e.g. `wiki/concepts`).
 * @param slug - Page slug; the file read is `<slug>.md` under the expected dir.
 * @returns `{content}` with the real bytes, or `{dropped}` (`"no-root"`,
 *   `"escapes-dir"`, or `"unreadable"`) — never the escaping target's bytes.
 */
export function readConfinedWikiPage(
  root: string,
  relDir: string,
  slug: string,
): Promise<ConfinedReadResult> {
  return diskLocalReads(root).readConfinedPage(relDir, slug);
}

/**
 * Read a fixed wiki file (e.g. `wiki/index.md`) confined to its EXACT parent
 * directory. Unlike {@link readConfinedWikiPage} this takes a full project-
 * relative path and performs no mkdir and no symlink-leaf alias handling: the
 * exact file is confined under `<root>/<dirname(relPath)>` and read through the
 * handle-bound reader. A symlinked file whose realpath escapes
 * that directory is DROPPED — its target bytes are never returned.
 *
 * @param root - Project root path (raw; canonicalized internally via realpath).
 * @param relPath - Project-relative file path (e.g. `wiki/index.md`).
 * @returns `{content}` with the real bytes, or `{dropped}` (`"no-root"`,
 *   `"escapes-dir"`, or `"unreadable"`) — never the escaping target's bytes.
 */
export function readConfinedWikiFile(
  root: string,
  relPath: string,
): Promise<ConfinedReadResult> {
  return diskLocalReads(root).readConfinedFile(relPath);
}

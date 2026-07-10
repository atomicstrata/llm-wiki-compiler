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
 * the bytes through {@link readConfinedPage} — which binds the returned bytes to
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
import { lstat } from "fs/promises";
import { safeRealpath, isInsideDir } from "../utils/path-confine.js";
import { readConfinedPage } from "../utils/confined-read.js";
import * as output from "../utils/output.js";

/** A confined read outcome: either the file's bytes, or a drop reason. */
export type ConfinedReadResult = { content: string } | { dropped: string };

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
function warnDroppedWikiRead(relPath: string, reason: string): void {
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
 * @param absPath - Absolute path of the wiki file that was dropped.
 * @param relPath - Project-relative path to name in the warning.
 * @param reason - The machine-readable drop reason.
 */
export async function warnDroppedWikiReadIfPresent(
  absPath: string,
  relPath: string,
  reason: string,
): Promise<void> {
  const exists = await lstat(absPath).then(() => true, () => false);
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
export async function readWikiPageContentOrWarn(
  root: string,
  relDir: string,
  slug: string,
  warnAlways = true,
): Promise<string> {
  const result = await readWikiPageOrWarn(root, relDir, slug, warnAlways);
  return "content" in result ? result.content : "";
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
 * @param root - Project root the page must resolve under.
 * @param relDir - Project-relative directory the page must stay inside.
 * @param slug - Page slug (`<slug>.md` is read under `relDir`).
 * @param warnAlways - Warn on every drop (scan sites), else only when present.
 * @returns The confined read result, after emitting any drop warning.
 */
async function readWikiPageOrWarn(
  root: string,
  relDir: string,
  slug: string,
  warnAlways = true,
): Promise<ConfinedReadResult> {
  const result = await readConfinedWikiPage(root, relDir, slug);
  return emitDropWarning(result, path.join(root, relDir), path.join(relDir, `${slug}.md`), warnAlways);
}

/**
 * Read one wiki page confined to the EXACT absolute directory `absScanDir`
 * (the directory itself is the confinement boundary). Used by directory-SCAN
 * sites — `indexgen.scanWikiPages` and `obsidian.loadConceptPages` — which hold
 * an absolute scan dir, not a project-root + relative-dir pair. This avoids the
 * fragile `dirname`/`basename` back-derivation those sites used to repeat, and
 * confines `<absScanDir>/<slug>.md` directly via the shared
 * realpath + isInsideDir + handle-bound read flow.
 *
 * Returns the discriminated result so callers keep the EMPTY-vs-DROPPED
 * distinction; a drop warning is emitted here per `warnAlways` (defaulting to
 * `true`, since scan callers iterate `readdir` entries that provably exist).
 *
 * @param absScanDir - Absolute directory the page must stay inside.
 * @param slug - Page slug; the file read is `<slug>.md` under `absScanDir`.
 * @param warnAlways - Warn on every drop (the scan default), else only when present.
 * @returns The confined read result, after emitting any drop warning.
 */
export async function readWikiPageInDirOrWarn(
  absScanDir: string,
  slug: string,
  warnAlways = true,
): Promise<ConfinedReadResult> {
  const canonicalDir = await safeRealpath(absScanDir);
  const result: ConfinedReadResult = canonicalDir
    ? await readConfinedExactFile(canonicalDir, path.join(canonicalDir, `${slug}.md`))
    : { dropped: "no-root" };
  return emitDropWarning(result, absScanDir, `${slug}.md`, warnAlways);
}

/**
 * Emit the drop warning for a confined read result and return it unchanged.
 * Centralizes the `warnAlways` branch so every "…OrWarn" wrapper shares one
 * policy: warn on every drop, or only when the file physically exists.
 *
 * @param result - The confined read outcome to inspect.
 * @param absDir - Absolute directory the page lives in (for the no-follow lstat).
 * @param relPath - Path named in the warning message.
 * @param warnAlways - Warn on every drop, else only when the file is present.
 * @returns `result`, unchanged.
 */
async function emitDropWarning(
  result: ConfinedReadResult,
  absDir: string,
  relPath: string,
  warnAlways: boolean,
): Promise<ConfinedReadResult> {
  if ("content" in result) return result;
  if (warnAlways) warnDroppedWikiRead(relPath, result.dropped);
  else await warnDroppedWikiReadIfPresent(path.join(absDir, path.basename(relPath)), relPath, result.dropped);
  return result;
}

/**
 * Read the exact `filePath` confined to `expectedDir` through the handle-bound,
 * no-follow {@link readConfinedPage}. Returns `{dropped:"escapes-dir"}` if the
 * realpath is missing or escapes the dir (never reads the target), or
 * `{dropped:"unreadable"}` if the confined read itself fails closed.
 */
async function readConfinedExactFile(
  expectedDir: string,
  filePath: string,
): Promise<ConfinedReadResult> {
  const real = await safeRealpath(filePath);
  if (!real || !isInsideDir(real, expectedDir)) return { dropped: "escapes-dir" };
  const content = await readConfinedPage(real, expectedDir);
  if (content === null) return { dropped: "unreadable" };
  return { content };
}

/**
 * Read a wiki page confined to its EXACT expected directory. The file
 * `<root>/<relDir>/<slug>.md` is resolved, and a symlink whose realpath escapes
 * `<root>/<relDir>` is DROPPED — its target is never read or emitted. The body
 * is read through {@link readConfinedPage}, so the no-follow handle-bound read
 * also defeats a TOCTOU parent-directory swap.
 *
 * @param root - Project root path (raw; canonicalized internally via realpath).
 * @param relDir - Project-relative directory the page must stay inside
 *   (e.g. `wiki/concepts`).
 * @param slug - Page slug; the file read is `<slug>.md` under the expected dir.
 * @returns `{content}` with the real bytes, or `{dropped}` (`"no-root"`,
 *   `"escapes-dir"`, or `"unreadable"`) — never the escaping target's bytes.
 */
export async function readConfinedWikiPage(
  root: string,
  relDir: string,
  slug: string,
): Promise<ConfinedReadResult> {
  const canonicalRoot = await safeRealpath(root);
  if (!canonicalRoot) return { dropped: "no-root" };
  const expectedDir = path.join(canonicalRoot, relDir);
  const filePath = path.join(expectedDir, `${slug}.md`);
  return readConfinedExactFile(expectedDir, filePath);
}

/**
 * Read a fixed wiki file (e.g. `wiki/index.md`) confined to its EXACT parent
 * directory. Unlike {@link readConfinedWikiPage} this takes a full project-
 * relative path and performs no mkdir and no symlink-leaf alias handling: the
 * exact file is confined under `<root>/<dirname(relPath)>` and read through the
 * handle-bound {@link readConfinedPage}. A symlinked file whose realpath escapes
 * that directory is DROPPED — its target bytes are never returned.
 *
 * @param root - Project root path (raw; canonicalized internally via realpath).
 * @param relPath - Project-relative file path (e.g. `wiki/index.md`).
 * @returns `{content}` with the real bytes, or `{dropped}` (`"no-root"`,
 *   `"escapes-dir"`, or `"unreadable"`) — never the escaping target's bytes.
 */
export async function readConfinedWikiFile(
  root: string,
  relPath: string,
): Promise<ConfinedReadResult> {
  const canonicalRoot = await safeRealpath(root);
  if (!canonicalRoot) return { dropped: "no-root" };
  const expectedDir = path.join(canonicalRoot, path.dirname(relPath));
  const filePath = path.join(canonicalRoot, relPath);
  return readConfinedExactFile(expectedDir, filePath);
}

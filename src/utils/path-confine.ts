/**
 * Path-confinement helpers shared by source/wiki readers. Used to drop any
 * entry whose `realpath` escapes its intended directory (e.g. a symlinked
 * `sources/leak.md` pointing outside the project), preventing local-file-read.
 *
 * Also exports `resolveSourcesDir` which additionally guards against the
 * `sources/` directory itself being a symlink to an outside location, and
 * `confinedRegularFile` — the single definition of "a source file" used by
 * the scan, list, get, and delete paths to stay in agreement.
 */
import { realpath, lstat } from "fs/promises";
import path from "path";
import { SOURCES_DIR } from "./constants.js";

/** `realpath` that returns null instead of throwing on missing/broken paths. */
export async function safeRealpath(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/**
 * True when `child` equals `dir` or sits beneath it.
 *
 * Takes NATIVE paths — absolute realpaths — and so compares with `path.sep`.
 * For canonical repo-relative POSIX strings, such as profile-declared
 * directories, use `isInsidePosixDir` from `../profile/paths.js` instead:
 * comparing `/`-joined strings with `path.sep` rejects every nested path on
 * win32 (issue #163).
 */
export function isInsideDir(child: string, dir: string): boolean {
  if (child === dir) return true;
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return child.startsWith(prefix);
}

/**
 * Rewrite a NATIVE relative path to its POSIX form (`\` → `/` on win32, identity
 * elsewhere).
 *
 * `path.relative`/`path.join` emit the PLATFORM separator, which is wrong the
 * moment the result stops being a filesystem argument and becomes portable
 * content — a markdown link, a stored id, a serialized record. On win32 those
 * silently gain backslashes and break for every consumer that expects `/`
 * (issue #163, same class as the profile-path fix).
 *
 * Only for RELATIVE paths: an absolute win32 path (`C:\...`) is not made
 * meaningful by swapping separators.
 *
 * Splits on `sep` ALONE, never on `[\\/]`: on POSIX a backslash is a legal
 * filename character, so rewriting it there would corrupt a real file name.
 * `sep` is a parameter purely as a test seam. CI runs Linux only (see the note
 * in `.github/workflows/ci.yml`), so asserting the win32 behaviour from a POSIX
 * runner is the ONLY coverage this has — not a stopgap until a Windows job
 * lands.
 *
 * @param relativePath - A relative path in the separator convention of `sep`.
 * @param sep - Separator to split on. Defaults to the running platform's.
 */
export function toPosixPath(relativePath: string, sep: string = path.sep): string {
  return relativePath.split(sep).join(path.posix.sep);
}

/**
 * Resolve `dir`/`name` to its real path IF it is a confined REGULAR FILE — i.e.
 * a real file (not a symlink, not a directory) whose realpath stays within `dir`.
 * Returns null otherwise. This is the single definition of "a source file": a
 * symlink in `sources/` (whether escaping or an in-tree alias) is never a source,
 * keeping reads, the identity scan, and writes in agreement.
 */
export async function confinedRegularFile(dir: string, name: string): Promise<string | null> {
  const entryPath = path.join(dir, name);
  let st;
  try {
    st = await lstat(entryPath); // lstat: do NOT follow — a symlink must be rejected
  } catch {
    return null;
  }
  if (!st.isFile()) return null; // symlink / directory / other → not a source
  const real = await safeRealpath(entryPath);
  if (real === null || !isInsideDir(real, dir)) return null; // defense-in-depth
  return real;
}

/**
 * Resolve the trusted on-disk sources directory for `root`: `<realpath(root)>/sources`,
 * requiring `sources/` to be a REAL directory at that literal path. A symlinked
 * `sources/` (which would redirect every read/write outside the project) yields null.
 * Returns null when root is missing or `sources/` is absent / not a real directory.
 */
export async function resolveSourcesDir(root: string): Promise<string | null> {
  const canonicalRoot = await safeRealpath(root);
  if (canonicalRoot === null) return null;
  const sourcesDir = path.join(canonicalRoot, SOURCES_DIR);
  try {
    const st = await lstat(sourcesDir);
    if (!st.isDirectory()) return null; // symlink or non-dir → not trusted
  } catch {
    return null; // missing
  }
  return sourcesDir;
}

/**
 * Confine a caller-supplied path under `root` and return its absolute form, or THROW.
 * `mustExist:true` (an input dir) requires the realpath to exist inside root.
 * `mustExist:false` (an output dir that may not exist yet) resolves lexically, then
 * realpath-checks the nearest existing path AT OR ABOVE the target — starting with the
 * target itself — so an existing symlinked dir/parent that escapes root is rejected.
 */
export async function confineUnderRoot(
  target: string,
  root: string,
  opts: { mustExist: boolean },
): Promise<string> {
  const realRoot = (await safeRealpath(root)) ?? path.resolve(root);
  const abs = path.normalize(path.resolve(realRoot, target));
  if (!isInsideDir(abs, realRoot)) throw new Error(`path escapes project root: ${target}`);
  if (opts.mustExist) {
    const real = await safeRealpath(abs);
    if (real === null || !isInsideDir(real, realRoot)) throw new Error(`path escapes project root: ${target}`);
    return real;
  }
  for (let cur = abs; ; cur = path.dirname(cur)) {
    const real = await safeRealpath(cur);
    if (real !== null) {
      if (!isInsideDir(real, realRoot)) throw new Error(`path escapes project root: ${target}`);
      break;
    }
    if (path.dirname(cur) === cur) break; // reached filesystem root without an existing ancestor
  }
  return abs;
}

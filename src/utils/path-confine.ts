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
import { lstat } from "./fs-metadata.js";
import path from "path";
import { SOURCES_DIR } from "./constants.js";
import { portableRealpath } from "./portable-realpath.js";

/** Opt in to distinguishing genuine I/O faults from absent or unsafe paths. */
export interface StrictIoOptions { strictIo?: boolean }

/**
 * `realpath` that returns null on missing/broken paths; legacy calls swallow faults.
 * Portable, so a present-but-unreadable leaf still resolves and its read fault
 * surfaces where it is opened, as under Node (see {@link portableRealpath}).
 */
export async function safeRealpath(p: string, opts: StrictIoOptions = {}): Promise<string | null> {
  try {
    return await portableRealpath(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (opts.strictIo && !["ENOENT", "ENOTDIR", "ELOOP"].includes(code ?? "")) throw err;
    return null;
  }
}

/**
 * {@link safeRealpath} of `p`, looked up on the first call and kept for every
 * later one, concurrent calls included. A path that does not resolve is not
 * kept, so it is looked up again on the next call. For a directory that one
 * operation reads many files under: keeping its real path is safe where each
 * file read re-resolves the file and checks it is inside that directory.
 */
export function realpathOnce(p: string): () => Promise<string | null> {
  let lookup: Promise<string | null> | undefined;
  return () => {
    lookup ??= safeRealpath(p).then((real) => {
      if (real === null) lookup = undefined;
      return real;
    });
    return lookup;
  };
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
    // Nested IDs must not bypass the scanner's refusal to walk directory aliases.
    for (let parent = path.dirname(entryPath); parent !== dir; parent = path.dirname(parent)) {
      if (!isInsideDir(parent, dir) || !(await lstat(parent)).isDirectory()) return null;
    }
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
 * Resolve `<realpath(root)>/<relDir>`, requiring it to be a REAL directory at
 * that literal path. A symlinked directory (which would redirect every read and
 * write outside the project) yields null, as does a missing root or directory.
 */
export async function resolveRealDir(root: string, relDir: string): Promise<string | null> {
  const canonicalRoot = await safeRealpath(root);
  if (canonicalRoot === null) return null;
  const realDir = path.join(canonicalRoot, relDir);
  try {
    const st = await lstat(realDir);
    if (!st.isDirectory()) return null; // symlink or non-dir → not trusted
  } catch {
    return null; // missing
  }
  return realDir;
}

/**
 * Resolve the trusted on-disk sources directory for `root`: `<realpath(root)>/sources`,
 * requiring `sources/` to be a REAL directory at that literal path. A symlinked
 * `sources/` (which would redirect every read/write outside the project) yields null.
 * Returns null when root is missing or `sources/` is absent / not a real directory.
 */
export function resolveSourcesDir(root: string): Promise<string | null> {
  return resolveRealDir(root, SOURCES_DIR);
}

/** The nearest path at or above `start` that resolves, with its realpath; with `onlyStart`, `start` alone. */
async function nearestExistingRealpath(start: string, onlyStart: boolean): Promise<{ at: string; real: string } | null> {
  for (let at = start; ; at = path.dirname(at)) {
    const real = await safeRealpath(at);
    if (real !== null) return { at, real };
    if (onlyStart || path.dirname(at) === at) return null; // no existing ancestor up to the filesystem root
  }
}

/**
 * Confine a caller-supplied path under `root` and return its absolute form, or THROW.
 * `mustExist:true` (an input dir) requires the realpath to exist inside root.
 * `mustExist:false` (an output dir that may not exist yet) resolves lexically, then
 * realpath-checks the nearest existing path AT OR ABOVE the target — starting with the
 * target itself — so an existing symlinked dir/parent that escapes root is rejected.
 *
 * The root is resolved only when the answer needs it. A realpath contains no
 * symlink, so when the nearest existing path under the LEXICAL root resolves to
 * itself, every prefix of it resolved to itself in that same lookup — the root
 * among them — and `realpath(root)` would be the lexical root: the target, the
 * checks and the answer are then exactly the ones below. Any other outcome (a
 * root given in another form, a symlink on the way, nothing existing under the
 * root) takes the full path, reusing the lookup when the root resolved to itself.
 */
export async function confineUnderRoot(
  target: string,
  root: string,
  opts: { mustExist: boolean },
): Promise<string> {
  const lexicalRoot = path.resolve(root);
  const lexicalAbs = path.normalize(path.resolve(lexicalRoot, target));
  const probe = isInsideDir(lexicalAbs, lexicalRoot) ? await nearestExistingRealpath(lexicalAbs, opts.mustExist) : undefined;
  if (probe && probe.real === probe.at && isInsideDir(probe.at, lexicalRoot)) return lexicalAbs;
  const realRoot = (await safeRealpath(root)) ?? lexicalRoot;
  const abs = path.normalize(path.resolve(realRoot, target));
  if (!isInsideDir(abs, realRoot)) throw new Error(`path escapes project root: ${target}`);
  const found = probe !== undefined && abs === lexicalAbs ? probe : await nearestExistingRealpath(abs, opts.mustExist);
  const escapes = found === null ? opts.mustExist : !isInsideDir(found.real, realRoot);
  if (escapes) throw new Error(`path escapes project root: ${target}`);
  return opts.mustExist && found !== null ? found.real : abs;
}

/**
 * @file test/fixtures/committed-source.ts
 * @description Read a committed source file's text once per test file.
 *
 * Static controls (import boundaries, forbidden references, citation indexes)
 * scan the same `src/` and `test/` files from several tests in one suite, and
 * each scan used to re-read every file: a suite with five such tests read the
 * whole tree five times. These files are the repository's own committed source,
 * which no test writes, so the first read's text is what every later read
 * would return. A file that fails to read fails the same way on every call.
 *
 * Not for files a test creates or mutates: those must be read from disk each
 * time, since what is on disk at that moment is what the test is about.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const texts = new Map<string, Promise<string>>();

/** The UTF-8 text of a committed source file; `file` is absolute or relative to the cwd. */
export function readCommittedSource(file: string): Promise<string> {
  const key = path.resolve(file);
  const cached = texts.get(key);
  if (cached !== undefined) return cached;
  const text = readFile(key, "utf8");
  texts.set(key, text);
  return text;
}

/**
 * @file src/compiler/batch/page-scan.ts
 * @description The STREAMED page scan the residual phases of a batch compile
 * share (link targets, related context, the resolver's title index, repair,
 * the index, the MOC): every `.md` page of one wiki page directory, ONE AT A
 * TIME, in the incumbent's listing order (a stable sort downstream therefore
 * breaks ties as the incumbent does).
 *
 * LISTING ORDER. The incumbent lists a directory with Node's `readdir`, which
 * (libuv's scandir) returns the names SORTED by `strcmp`, i.e. by their UTF-8
 * bytes, not in the file system's own order. The streamed listing (one entry
 * at a time, in raw file-system order) is therefore put through the run's
 * external sort by UTF-8 bytes ({@link listedPageNames}).
 *
 * Each page is then read through the bounded confined page read
 * (`./pages.ts`: a page that escapes its directory is dropped, warned about
 * only when something is at its path, and skipped; one above the page cap
 * refuses), so no scan holds more than one page body, one sort chunk and the
 * merge heads.
 */

import path from "node:path";
import { diskLocalReads, diskStreamingDirectory } from "../../storage/disk-local-reads.js";
import { warnDroppedReadIfPresentFrom } from "../confined-wiki-read.js";
import { ExternalSorter } from "./external-sort.js";
import { readPageBounded } from "./pages.js";
import type { BatchRun } from "./run-store.js";

/** One scanned page: its slug (the file stem) and its whole content. */
export interface ScannedPageText { readonly slug: string; readonly content: string }

/** The incumbent `readdir` order: names by their UTF-8 bytes (libuv sorts with `strcmp`). */
const byUtf8 = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Every `.md` name of `relDir`, in the incumbent's `readdir` order, sorted under `ns` (nothing when the directory is absent). */
export async function* listedPageNames(run: BatchRun, ns: string, relDir: string): AsyncGenerator<string> {
  const directory = await diskStreamingDirectory(run.root, relDir).catch(() => null);
  if (directory === null) return;
  const sorter = new ExternalSorter<string>(run, `${ns}l:`, byUtf8);
  for await (const entry of directory.entries("")) if (entry.name.endsWith(".md")) await sorter.add(entry.name);
  yield* sorter.sorted();
}

/** Every `.md` page of `relDir`, one at a time in the incumbent's listing order, listed under `ns`. */
export async function* scanPages(run: BatchRun, ns: string, relDir: string): AsyncGenerator<ScannedPageText> {
  const reads = diskLocalReads(run.root);
  for await (const name of listedPageNames(run, ns, relDir)) {
    const slug = name.slice(0, -".md".length);
    const read = await readPageBounded(run.root, relDir, slug);
    if ("dropped" in read) {
      await warnDroppedReadIfPresentFrom(reads, path.join(relDir, name), path.join(relDir, name), read.dropped);
      continue;
    }
    yield { slug, content: read.content };
  }
}

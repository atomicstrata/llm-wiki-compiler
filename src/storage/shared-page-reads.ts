/**
 * @file src/storage/shared-page-reads.ts
 * @description One confined read per wiki page across a read-only window.
 *
 * Compile's tail regenerates the index, then the map of contents, then the
 * embeddings, and each walks every concept and query page through its own
 * call chain, so each page was opened, checked and read three times. The
 * walks reach the page through different seams (the embeddings one sits
 * several calls deep), so rather than add a cache parameter to each layer,
 * {@link withSharedPageReads} opens a window and the disk page readers
 * consult it through {@link sharedPageRead}.
 *
 * Inside a window, the first read of `<canonicalDir>/<name>` is made and its
 * promise (result or rejection) is shared with every later ask; outside one,
 * every ask reads. A shared result passed the full confinement check when it
 * was read. Open a window only around steps that write no page the window
 * reads: a page written inside it would still answer with its first read.
 *
 * The walks also parse each page's frontmatter. {@link frontmatterOfRead}
 * keys that parse on the read's result object, so walks handed the same
 * shared result parse it once; a read made outside a window is a fresh
 * object and is parsed afresh. Callers must treat the parse as read-only.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ConfinedReadResult } from "./legacy-local-reads.js";
import { parseFrontmatter } from "../utils/markdown.js";

const sharedReads = new AsyncLocalStorage<Map<string, Promise<ConfinedReadResult>>>();

/** Run `steps` with page reads shared among them. See the file header. */
export function withSharedPageReads<T>(steps: () => Promise<T>): Promise<T> {
  return sharedReads.run(new Map(), steps);
}

/**
 * `read()`, or the result of the same page's earlier read in the current
 * window. `canonicalDir` and `name` identify the page; callers pass the
 * resolved directory, so walks that reach it by different paths share.
 */
export function sharedPageRead(
  canonicalDir: string,
  name: string,
  read: () => Promise<ConfinedReadResult>,
): Promise<ConfinedReadResult> {
  const window = sharedReads.getStore();
  if (!window) return read();
  const key = `${canonicalDir}\0${name}`;
  let pending = window.get(key);
  if (!pending) {
    pending = read();
    window.set(key, pending);
  }
  return pending;
}

/** A page read that returned content. */
type PageContent = Extract<ConfinedReadResult, { content: string }>;

const parsedReads = new WeakMap<PageContent, ReturnType<typeof parseFrontmatter>>();

/**
 * `parseFrontmatter(read.content)`, parsed once per read result. Shared
 * results (see the file header) share their parse; treat it as read-only.
 */
export function frontmatterOfRead(read: PageContent): ReturnType<typeof parseFrontmatter> {
  let parsed = parsedReads.get(read);
  if (!parsed) {
    parsed = parseFrontmatter(read.content);
    parsedReads.set(read, parsed);
  }
  return parsed;
}

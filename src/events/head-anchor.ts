/**
 * @file src/events/head-anchor.ts
 * @description The sealed HEAD ANCHOR of the event log (`.llmwiki/events.head`,
 * the digest of the last event): its no-follow, capped leaf read and the one
 * body that reads it. Shared by the single-file event reader and the segmented
 * event log; a leaf, so the segmented log never imports the reader that
 * dispatches to it.
 */

import path from "path";
import { EVENTS_HEAD_FILE, MAX_EVENT_HEAD_BYTES } from "../utils/constants.js";
import { openGraphFileRead, type SymlinkErrorFactory } from "../utils/jsonl-store.js";
import { readOpenedTextWithinCap } from "../utils/no-follow-open.js";
import { resolveExistingConfinedPrivateDir } from "../utils/private-dir.js";
import { EventStoreCorruptError, EventStoreSymlinkError } from "./types.js";

/** What one look at the head-anchor leaf found: nothing there, a leaf over the cap (never read), or its text. */
export type HeadLeafRead =
  | { kind: "absent" }
  | { kind: "oversize"; size: number }
  | { kind: "text"; text: string };

/** The two looks the head anchor needs: the private directory and one no-follow leaf in it. */
export interface HeadAnchorSources {
  /** The existing private directory, resolved WITHOUT creating it, or `null` when there is none. REJECTS on a confinement fault and on any other failure. */
  resolvePrivateDir(): Promise<string | null>;
  /**
   * One leaf of a resolved private directory, opened WITHOUT following a link.
   * A link or a non-regular leaf REJECTS with what `makeSymlinkError` builds; a
   * leaf over `maxBytes` is a value carrying its size and is never read; a
   * failed read or close REJECTS raw.
   */
  readHeadLeaf(dir: string, name: string, maxBytes: number, makeSymlinkError: SymlinkErrorFactory): Promise<HeadLeafRead>;
}

/** The event store's typed link error, built here for the graph read and for the head-anchor leaf alike. */
export function eventSymlinkError(reason: string): Error {
  return new EventStoreSymlinkError(reason);
}

/**
 * LOCAL DISK. The head-anchor leaf look: the no-follow open (a link or a
 * non-regular leaf fails closed), the size look, the read only when within the
 * cap, and the close in `finally`, in that order. A close that fails wins over
 * whatever the look had found, as it always did.
 */
async function readDiskHeadLeaf(file: string, maxBytes: number, makeSymlinkError: SymlinkErrorFactory): Promise<HeadLeafRead> {
  const handle = await openGraphFileRead(file, makeSymlinkError);
  if (handle === null) return { kind: "absent" };
  return readOpenedTextWithinCap(handle, maxBytes);
}

/** LOCAL DISK. The head-anchor looks of the project at `root`. Building them does no I/O. */
export function diskHeadAnchorSources(root: string): HeadAnchorSources {
  return {
    resolvePrivateDir: () => resolveExistingConfinedPrivateDir(root),
    readHeadLeaf: (dir, name, maxBytes, makeSymlinkError) => readDiskHeadLeaf(path.join(dir, name), maxBytes, makeSymlinkError),
  };
}

/**
 * Read the sealed head-anchor digest, or null when it is absent, over
 * {@link HeadAnchorSources}: THE ONE BODY. No private
 * directory and no leaf each mean no anchor; a leaf over the cap is this store's
 * corrupt error and was never read; the text is trimmed here.
 */
export async function readHeadAnchorFrom(sources: HeadAnchorSources): Promise<string | null> {
  const dir = await sources.resolvePrivateDir(); // throws on .llmwiki symlink escape
  if (dir === null) return null; // absent .llmwiki → no head anchor, clean project
  const read = await sources.readHeadLeaf(dir, path.basename(EVENTS_HEAD_FILE), MAX_EVENT_HEAD_BYTES, eventSymlinkError);
  if (read.kind === "absent") return null;
  if (read.kind === "oversize") {
    throw new EventStoreCorruptError(
      `head anchor file ${read.size} bytes exceeds the ${MAX_EVENT_HEAD_BYTES}-byte cap`,
    );
  }
  return read.text.trim();
}

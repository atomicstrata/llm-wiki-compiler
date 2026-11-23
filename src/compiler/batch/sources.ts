/**
 * @file src/compiler/batch/sources.ts
 * @description The BOUNDED source read of a batch compile: every source the
 * run hashes, extracts or revalidates is read through the confined leaf
 * reader (a regular file inside its expected `sources/` directory, never
 * through a link at the leaf, its parent bound by identity), refused above
 * {@link MAX_SOURCE_BYTES} BEFORE its bytes are allocated, and decoded as
 * UTF-8 exactly as the incumbent `readText` decodes it, so its SHA-256 (of
 * the decoded text) is the incumbent source hash.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { readConfinedLeafBuffer } from "../../utils/confined-read.js";
import { SOURCES_DIR } from "../../utils/constants.js";
import { BatchCompileError } from "./contracts.js";

/** The largest single source a batch compile reads; a larger one refuses the run before any effect. */
export const MAX_SOURCE_BYTES = 16 * 1024 * 1024;

/** One source's text and its incumbent hash. */
export interface SourceRead { readonly text: string; readonly hash: string; readonly bytes: number }

/** The SHA-256 hex of a source's decoded text, as the incumbent hashes it. */
export const sourceHashOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Read source `file` of the project at `root`, bounded and confined. */
export async function readSourceBounded(root: string, file: string): Promise<SourceRead> {
  const leaf = path.join(root, SOURCES_DIR, file);
  const read = await readConfinedLeafBuffer(root, leaf, path.dirname(leaf), MAX_SOURCE_BYTES);
  if (read.kind === "absent") throw new BatchCompileError("compile_batch_inputs_changed", `source ${file.slice(0, 80)} disappeared while the batch compile ran`);
  if (read.kind !== "ok") throw new BatchCompileError("compile_batch_source_unreadable", `source ${file.slice(0, 80)} is not a confined regular file within the ${MAX_SOURCE_BYTES}-byte batch source cap`);
  const text = read.body.toString("utf8");
  return { text, hash: sourceHashOf(text), bytes: read.body.byteLength };
}

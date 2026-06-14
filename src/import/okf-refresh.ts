/** @file Post-write refresh for trusted OKF imports (links, index, MOC, embeddings). */
import { resolveLinks } from "../compiler/resolver.js";
import { generateIndex } from "../compiler/indexgen.js";
import { generateMOC } from "../compiler/obsidian.js";
import { updateEmbeddings } from "../utils/embeddings.js";
import * as output from "../utils/output.js";

/** Update embeddings without letting an embeddings failure abort the import (mirrors the approve-path wrapper). */
async function safelyUpdateEmbeddings(root: string, slugs: string[]): Promise<void> {
  try {
    await updateEmbeddings(root, slugs);
  } catch (err) {
    output.status("!", output.warn(`Embeddings update skipped: ${err instanceof Error ? err.message : err}`));
  }
}

/** Rebuild derived artifacts after writing imported pages live. */
export async function refreshAfterImport(root: string, slugs: string[]): Promise<void> {
  await resolveLinks(root, slugs, slugs);
  await generateIndex(root);
  await generateMOC(root);
  await safelyUpdateEmbeddings(root, slugs);
}

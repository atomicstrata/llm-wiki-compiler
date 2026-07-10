/**
 * @file A minimal default-profile concept {@link ExportPage} for OKF export tests.
 *
 * Several OKF export suites need a single native concept page to drive a
 * DEFAULT-profile bundle (the byte-identical-parity baseline). Sharing the one
 * literal here keeps those suites from re-spelling (and drifting on) the same
 * fixture — and keeps the duplication analyzer quiet.
 */
import { mkdir, readFile } from "fs/promises";
import path from "path";
import { buildOkfBundle } from "../../src/export/okf/bundle.js";
import type { ExportPage } from "../../src/export/types.js";

/** A single "RAG" concept page for a default-profile OKF export. */
export function defaultConceptPage(): ExportPage {
  return {
    title: "RAG", slug: "rag", pageDirectory: "concepts", path: "wiki/concepts/rag.md",
    summary: "Grounded.", sources: [], tags: [], createdAt: "x", updatedAt: "y",
    links: [], body: "Body", citations: [], contentHash: "h", sourceHashes: [],
  } as ExportPage;
}

/**
 * Export a DEFAULT-profile bundle from `root` (one concept page) and return the
 * bundle dir plus its `index.md` contents — the shared baseline for the
 * byte-identical-parity assertions.
 *
 * @param root - Absolute project root directory.
 * @returns The bundle output dir and its `index.md` string.
 */
export async function exportDefaultBundleIndex(root: string): Promise<{ out: string; index: string }> {
  await mkdir(path.join(root, "sources"), { recursive: true });
  const out = path.join(root, "bundle");
  await buildOkfBundle(root, [defaultConceptPage()], out);
  return { out, index: await readFile(path.join(out, "index.md"), "utf-8") };
}

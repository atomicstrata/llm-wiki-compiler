/**
 * @file `llmwiki import --okf <dir> [--trusted]`. Default: stage each OKF doc as an
 * imported review candidate (untrusted external knowledge stays gated behind review).
 * `--trusted`: write mapped pages straight into wiki/ (validated + collision-checked).
 */
import path from "path";
import { importOkfBundle } from "../import/okf-import.js";
import { writeCandidate } from "../compiler/candidates.js";
import { validateWikiPage, atomicWrite } from "../utils/markdown.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { refreshAfterImport } from "../import/okf-refresh.js";
import { acquireLock, releaseLock } from "../utils/lock.js";
import * as output from "../utils/output.js";
import type { MappedOkfPage } from "../import/types.js";

/** CLI options for `import`. */
export interface ImportOptions { okf?: string; trusted?: boolean; }

/** Stage one mapped page as an imported review candidate. */
async function stageCandidate(root: string, page: MappedOkfPage): Promise<void> {
  await writeCandidate(root, {
    title: page.title, slug: page.slug, summary: page.summary, sources: page.sources, body: page.body,
    reviewMode: "imported", heldReasons: [{ code: "imported-okf" }],
    targetDirectory: page.targetDirectory, okfPath: page.okfPath,
  });
}

/**
 * Write mapped pages live (--trusted): validate, then atomic-write into the target dir.
 *
 * `validateWikiPage` only confirms a non-empty title + body — it is NOT an origin
 * check. Imported-origin attribution is guaranteed upstream by the mapper, which
 * always stamps `provenanceState: imported` and an `okf:<bundle>` source token.
 */
async function writeTrusted(root: string, pages: MappedOkfPage[]): Promise<void> {
  const written: string[] = [];
  for (const page of pages) {
    if (!validateWikiPage(page.body)) {
      output.status("!", output.warn(`OKF import: ${page.okfPath} failed page validation; not written.`));
      continue;
    }
    const dir = page.targetDirectory === "queries" ? QUERIES_DIR : CONCEPTS_DIR;
    await atomicWrite(path.join(root, dir, `${page.slug}.md`), page.body);
    written.push(page.slug);
  }
  if (written.length) await refreshAfterImport(root, written);
}

/**
 * Trusted import: collision-read + live write + refresh under `.llmwiki/lock` so a
 * concurrent `compile`/`approve` can't race the index/MOC rebuild we trigger.
 */
async function importTrusted(root: string, okf: string): Promise<void> {
  const locked = await acquireLock(root);
  if (!locked) {
    output.status("!", output.error("Could not acquire lock. Try again later."));
    process.exitCode = 1;
    return;
  }
  try {
    const { pages, skipped } = await importOkfBundle(okf, root);
    await writeTrusted(root, pages);
    output.status("+", output.success(`OKF import: wrote ${pages.length} page(s); skipped ${skipped.length}.`));
  } finally {
    await releaseLock(root);
  }
}

/** Import an OKF bundle into the current project. */
export default async function importCommand(root: string, options: ImportOptions): Promise<void> {
  if (!options.okf) throw new Error("import: --okf <dir> is required");
  if (options.trusted) {
    await importTrusted(root, options.okf);
    return;
  }
  const { pages, skipped } = await importOkfBundle(options.okf, root);
  for (const p of pages) await stageCandidate(root, p);
  output.status("+", output.success(`OKF import: staged ${pages.length} page(s); skipped ${skipped.length}.`));
}

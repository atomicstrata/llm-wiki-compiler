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

/** Write mapped pages live (--trusted): validate, then atomic-write into the target dir. */
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

/** Import an OKF bundle into the current project. */
export default async function importCommand(root: string, options: ImportOptions): Promise<void> {
  if (!options.okf) throw new Error("import: --okf <dir> is required");
  const { pages, skipped } = await importOkfBundle(options.okf, root);
  if (options.trusted) await writeTrusted(root, pages);
  else { for (const p of pages) await stageCandidate(root, p); }
  const verb = options.trusted ? "wrote" : "staged";
  output.status("+", output.success(`OKF import: ${verb} ${pages.length} page(s); skipped ${skipped.length}.`));
}

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
 * True if a mapped page is writable; warns + returns false otherwise (skip-and-warn, both paths).
 *
 * `validateWikiPage` only confirms a non-empty title + body — it is NOT an origin
 * check. Imported-origin attribution is guaranteed upstream by the mapper, which
 * always stamps `provenanceState: imported` and an `okf:<bundle>` source token.
 */
function validForWrite(page: MappedOkfPage): boolean {
  if (validateWikiPage(page.body)) return true;
  output.status("!", output.warn(`OKF import: ${page.okfPath} failed page validation; skipped.`));
  return false;
}

/** Write already-validated mapped pages live (--trusted): atomic-write into the target dir, then refresh. */
async function writeTrusted(root: string, pages: MappedOkfPage[]): Promise<void> {
  const written: string[] = [];
  for (const page of pages) {
    const dir = page.targetDirectory === "queries" ? QUERIES_DIR : CONCEPTS_DIR;
    await atomicWrite(path.join(root, dir, `${page.slug}.md`), page.body);
    written.push(page.slug);
  }
  if (written.length) await refreshAfterImport(root, written);
}

/**
 * Import an OKF bundle into the current project.
 *
 * The whole operation runs under `.llmwiki/lock`: BOTH the default staging path
 * (collision-read + candidate list→write→dedup canonicalization) and `--trusted`
 * (collision-read + live write + index/MOC refresh) are durable read-modify-writes
 * that must not race a concurrent `compile`/`approve`.
 */
export default async function importCommand(root: string, options: ImportOptions): Promise<void> {
  if (!options.okf) throw new Error("import: --okf <dir> is required");
  const locked = await acquireLock(root);
  if (!locked) {
    output.status("!", output.error("Could not acquire lock. Try again later."));
    process.exitCode = 1;
    return;
  }
  try {
    const { pages, skipped } = await importOkfBundle(options.okf, root);
    const valid = pages.filter(validForWrite);
    if (options.trusted) await writeTrusted(root, valid);
    else { for (const p of valid) await stageCandidate(root, p); }
    const verb = options.trusted ? "wrote" : "staged";
    const dropped = skipped.length + (pages.length - valid.length);
    output.status("+", output.success(`OKF import: ${verb} ${valid.length} page(s); skipped ${dropped}.`));
  } finally {
    await releaseLock(root);
  }
}

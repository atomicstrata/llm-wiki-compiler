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
import type { SkippedOkfPage } from "../import/okf-collision.js";

/** CLI options for `import`. */
export interface ImportOptions { okf?: string; trusted?: boolean; dryRun?: boolean; }

/** Stage one mapped page as an imported review candidate. */
async function stageCandidate(root: string, page: MappedOkfPage): Promise<void> {
  await writeCandidate(root, {
    title: page.title, slug: page.slug, summary: page.summary, sources: page.sources, body: page.body,
    reviewMode: "imported", heldReasons: [{ code: "imported-okf" }],
    targetDirectory: page.targetDirectory, okfPath: page.okfPath,
  });
}

/**
 * A mapped page is writable iff it has a non-empty slug and passes page validation.
 *
 * The empty-slug guard prevents writing `concepts/.md` for a doc whose path slugifies
 * to "" (a real title alone passes `validateWikiPage`, which only checks title + body).
 * `validateWikiPage` is NOT an origin check — imported-origin attribution is guaranteed
 * upstream by the mapper, which stamps `provenanceState: imported` + an `okf:` source token.
 */
export function isWritable(page: MappedOkfPage): boolean {
  return page.slug.length > 0 && validateWikiPage(page.body);
}

/** True if writable; warns + returns false otherwise (skip-and-warn, used by both write paths). */
function validForWrite(page: MappedOkfPage): boolean {
  if (isWritable(page)) return true;
  output.status("!", output.warn(`OKF import: ${page.okfPath} (slug "${page.slug}") failed validation; skipped.`));
  return false;
}

/**
 * Write already-validated mapped pages live (--trusted): atomic-write into the target
 * dir, then refresh. If a write throws mid-loop, the already-written subset is still
 * refreshed (index/MOC stay consistent) before the error propagates.
 */
async function writeTrusted(root: string, pages: MappedOkfPage[]): Promise<void> {
  const written: string[] = [];
  try {
    for (const page of pages) {
      const dir = page.targetDirectory === "queries" ? QUERIES_DIR : CONCEPTS_DIR;
      await atomicWrite(path.join(root, dir, `${page.slug}.md`), page.body);
      written.push(page.slug);
    }
  } finally {
    if (written.length) await refreshAfterImport(root, written);
  }
}

/** Print the per-page breakdown of a dry-run: what would be written, what's invalid, what collides. */
function reportPreview(pages: MappedOkfPage[], skipped: SkippedOkfPage[]): void {
  for (const p of pages) {
    if (isWritable(p)) {
      output.status("+", `${p.slug} (${p.targetDirectory}) ← ${p.okfPath}`);
    } else {
      output.status("!", output.warn(`invalid (empty slug/title/body): ${p.okfPath}`));
    }
  }
  for (const s of skipped) output.status("!", output.warn(`skip ${s.okfPath} — ${s.reason}`));
}

/** Report what an import WOULD stage/write and what it would skip, without mutating anything (read-only, no lock). */
async function previewImport(root: string, okf: string): Promise<void> {
  const { pages, skipped } = await importOkfBundle(okf, root);
  const writable = pages.filter(isWritable).length;
  const dropped = skipped.length + (pages.length - writable);
  output.status("i", output.dim(`Dry run — would import ${writable} page(s); skip ${dropped}.`));
  reportPreview(pages, skipped);
}

/**
 * Import an OKF bundle into the current project.
 *
 * The whole operation runs under `.llmwiki/lock`: BOTH the default staging path
 * (collision-read + candidate list→write→dedup canonicalization) and `--trusted`
 * (collision-read + live write + index/MOC refresh) are durable read-modify-writes
 * that must not race a concurrent `compile`/`approve`. `--dry-run` is read-only and
 * takes no lock.
 */
export default async function importCommand(root: string, options: ImportOptions): Promise<void> {
  if (!options.okf) throw new Error("import: --okf <dir> is required");
  if (options.dryRun) {
    await previewImport(root, options.okf);
    return;
  }
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

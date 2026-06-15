// src/import/run.ts
/** @file Output-free OKF import core shared by CLI/SDK/MCP: read→map→collision→validate→stage/write/preview, returning a structured report. Owns the .llmwiki lock. */
import path from "path";
import { importOkfBundle } from "./okf-import.js";
import { isWritable } from "../commands/import-core.js"; // leaf created in Task 4 Step 0
import { writeCandidate, listCandidates } from "../compiler/candidates.js";
import { atomicWrite } from "../utils/markdown.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { refreshAfterImport } from "./okf-refresh.js";
import { acquireLock, releaseLock } from "../utils/lock.js";
import { LockUnavailableError, QueueFullError } from "./run-errors.js";
import type { MappedOkfPage } from "./types.js";

export interface OkfImportSkip { slug: string; okfPath: string; reason: "live-page" | "pending-candidate" | "duplicate-in-bundle" | "invalid-page"; }
export interface OkfImportedPage { slug: string; okfPath: string; targetDirectory: "concepts" | "queries"; }
export interface OkfImportReport {
  mode: "staged" | "written" | "dry-run";
  pages: OkfImportedPage[];
  skipped: OkfImportSkip[];
  warnings: string[];
  nextAction?: string;
}
export interface OkfImportOptions { trusted?: boolean; dryRun?: boolean; maxNewCandidates?: number; }

const toImported = (p: MappedOkfPage): OkfImportedPage => ({ slug: p.slug, okfPath: p.okfPath, targetDirectory: p.targetDirectory });

/** Partition mapped pages (single pass) + assemble the skip list (collisions ∪ invalid). */
function partition(pages: MappedOkfPage[], collisionSkips: OkfImportSkip[]): { valid: MappedOkfPage[]; skipped: OkfImportSkip[] } {
  const valid: MappedOkfPage[] = [];
  const invalid: OkfImportSkip[] = [];
  for (const p of pages) {
    if (isWritable(p)) valid.push(p);
    else invalid.push({ slug: p.slug, okfPath: p.okfPath, reason: "invalid-page" });
  }
  return { valid, skipped: [...collisionSkips, ...invalid] };
}

async function stageAll(root: string, valid: MappedOkfPage[]): Promise<void> {
  for (const page of valid) {
    await writeCandidate(root, {
      title: page.title, slug: page.slug, summary: page.summary, sources: page.sources, body: page.body,
      reviewMode: "imported", heldReasons: [{ code: "imported-okf" }],
      targetDirectory: page.targetDirectory, okfPath: page.okfPath,
    });
  }
}

async function writeAll(root: string, valid: MappedOkfPage[]): Promise<void> {
  const written: string[] = [];
  try {
    for (const page of valid) {
      const dir = page.targetDirectory === "queries" ? QUERIES_DIR : CONCEPTS_DIR;
      await atomicWrite(path.join(root, dir, `${page.slug}.md`), page.body);
      written.push(page.slug);
    }
  } finally {
    if (written.length) await refreshAfterImport(root, written);
  }
}

/** Read→map→collision→validate→stage/write/preview an OKF bundle; output-free; returns a report. */
export async function runOkfImport(root: string, dir: string, opts: OkfImportOptions = {}): Promise<OkfImportReport> {
  const warnings: string[] = [];
  if (opts.dryRun) {
    const { pages, skipped } = await importOkfBundle(dir, root, {}, (m) => warnings.push(m));
    const { valid, skipped: allSkipped } = partition(pages, skipped as OkfImportSkip[]);
    return { mode: "dry-run", pages: valid.map(toImported), skipped: allSkipped, warnings, nextAction: "Re-run without dryRun to apply." };
  }
  const locked = await acquireLock(root);
  if (!locked) throw new LockUnavailableError();
  try {
    const { pages, skipped } = await importOkfBundle(dir, root, {}, (m) => warnings.push(m));
    const { valid, skipped: allSkipped } = partition(pages, skipped as OkfImportSkip[]);
    if (opts.maxNewCandidates !== undefined && !opts.trusted) {
      const pending = (await listCandidates(root)).length;
      if (pending + valid.length > opts.maxNewCandidates) throw new QueueFullError();
    }
    if (opts.trusted) await writeAll(root, valid);
    else await stageAll(root, valid);
    return {
      mode: opts.trusted ? "written" : "staged",
      pages: valid.map(toImported),
      skipped: allSkipped,
      warnings,
      nextAction: opts.trusted ? `${valid.length} page(s) written live.` : "Review and approve before it goes live: llmwiki review list.",
    };
  } finally {
    await releaseLock(root);
  }
}

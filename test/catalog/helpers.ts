/**
 * @file test/catalog/helpers.ts
 * @description Fixtures for catalog tests: synthetic page and source files on
 * real disk, and an ACTIVATED `local-indexed` project (a coherent version 2
 * record naming `local-indexed` active, a reconciled catalog and the
 * histories imported by the real import body). The
 * activation shortcut stands in for a full preparation, which the scale
 * tests exercise separately.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { openCatalog } from "../../src/catalog/meta.js";
import { syncCatalog } from "../../src/catalog/sync.js";
import { importHistories } from "../../src/history/history-import.js";
import { importVectors } from "../../src/vectors/import.js";
import type { ScaleRecord } from "../../src/scale/contracts-v2.js";
import { nextRecord } from "../../src/scale/next-record.js";
import { planScaleV2 } from "../../src/scale/plan-v2.js";
import { diskScaleRecordIo, writeScaleRecordFrom } from "../../src/scale/record.js";

/** A page file's text. */
export function pageText(title: string, extra = ""): string {
  return `---\ntitle: ${title}\nsummary: About ${title}\ntags: [t1]\n${extra}---\n\nBody of ${title} linking [[other-page]].\n`;
}

/** A source file's text. */
export function sourceText(title: string, source: string): string {
  return `---\ntitle: ${title}\nsource: ${source}\nsourceType: file\ningestedAt: "2026-01-01T00:00:00Z"\n---\n\nSource body for ${title}. ${"words ".repeat(40)}\n`;
}

/** Write `pages` concept pages and `sources` sources (flat), named with zero-padded indices. */
export async function writeCorpus(root: string, pages: number, sources: number): Promise<void> {
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await mkdir(path.join(root, "wiki", "queries"), { recursive: true });
  await mkdir(path.join(root, "sources"), { recursive: true });
  for (let at = 0; at < pages; at += 1) {
    const slug = `page-${String(at).padStart(5, "0")}`;
    await writeFile(path.join(root, "wiki", "concepts", `${slug}.md`), pageText(`Page ${at}`));
  }
  for (let at = 0; at < sources; at += 1) {
    const name = `src-${String(at).padStart(5, "0")}.md`;
    await writeFile(path.join(root, "sources", name), sourceText(`Source ${at}`, `manual:source-${at}`));
  }
}

/** Record a pending `local-indexed` transition (as `scale set --no-prepare` would); returns that record. */
export async function recordIndexedTransition(root: string): Promise<ScaleRecord> {
  const pending = nextRecord(null, planScaleV2({ documents: 8_000 }));
  await writeScaleRecordFrom(diskScaleRecordIo(root), pending);
  return pending;
}

/**
 * Everything activating `local-indexed` on `root` does BEFORE the activated
 * record: record the transition (as `scale set --no-prepare` would) and run
 * the real catalog, history and vector bodies while it is pending. The project
 * is still not `local-indexed`; returns the pending record.
 */
export async function prepareIndexedActivation(root: string): Promise<ScaleRecord> {
  const pending = await recordIndexedTransition(root);
  await importHistories(root);
  await importVectors(root);
  await syncCatalog(root, await openCatalog(root));
  return pending;
}

/** Publish the activated record for `pending`: from here on the project at `root` is `local-indexed`. */
export async function publishIndexedActivation(root: string, pending: ScaleRecord): Promise<void> {
  await writeScaleRecordFrom(diskScaleRecordIo(root), { ...pending, active: { architecture: "local-indexed", sinceRevision: 1 }, pending: null } as ScaleRecord);
}

/** Activate `local-indexed` on `root` directly: {@link prepareIndexedActivation}, then {@link publishIndexedActivation}. */
export async function activateIndexed(root: string): Promise<void> {
  await publishIndexedActivation(root, await prepareIndexedActivation(root));
}

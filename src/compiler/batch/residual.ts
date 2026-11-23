/**
 * @file src/compiler/batch/residual.ts
 * @description The RESIDUAL phase of a batch compile: everything the
 * incumbent does after its single state flush, as resumable steps, each a
 * checkpoint (`cursor.step`):
 *
 * 1. `catalog`: the bounded catalog reconciliation (`./residual-catalog.ts`).
 * 2. `index`, then `moc`: the bounded index and MOC (`./residual-index.ts`).
 * 3. `log`: the incumbent `compile` entry of `log.md` (nothing when nothing
 *    was compiled or deleted), its lists capped as the incumbent caps them
 *    and built from the run rows without holding them. A crash after the
 *    append and before its checkpoint can repeat the entry.
 *
 * The run is then `done`. A batch compile refreshes NO embeddings: the
 * incumbent drain is not bounded, so the driver refuses a batch compile with
 * embeddings on before any effect (`--no-embeddings` / `embeddings: false`).
 */

import { appendLog } from "../../utils/activity-log.js";
import { LOG_MAX_PAGE_LINKS } from "../../utils/constants.js";
import type { ToExtractV1 } from "./closure.js";
import type { GeneratedPageV1 } from "./generate.js";
import type { PlannedPageV1 } from "./generation-plan.js";
import { reconcileCatalogBounded } from "./residual-catalog.js";
import { generateIndexBounded, generateMocBounded } from "./residual-index.js";
import type { BatchRun } from "./run-store.js";

/** The residual steps, in order. */
const STEPS = ["catalog", "index", "moc", "log"] as const;
type ResidualStep = (typeof STEPS)[number];

/** A list capped as the incumbent `formatList` caps it, built one item at a time. */
class CappedList {
  private readonly shown: string[] = [];
  count = 0;

  /** Add one item. */
  add(item: string): void {
    if (this.count++ < LOG_MAX_PAGE_LINKS) this.shown.push(item);
  }

  /** The incumbent rendering: the shown items, then `, … (+n more)`. */
  toString(): string {
    const remaining = this.count - this.shown.length;
    return this.shown.join(", ") + (remaining > 0 ? `, … (+${remaining} more)` : "");
  }
}

/** The created and updated pages of the run (each produced slug once, concept pages first). */
async function producedLists(run: BatchRun): Promise<{ created: CappedList; updated: CappedList }> {
  const created = new CappedList();
  const updated = new CappedList();
  for await (const row of run.scan("go:")) {
    const { slug } = row.v as PlannedPageV1;
    const page = (await run.get(`gr:${slug}`)) as GeneratedPageV1 | undefined;
    if (page?.written === true) (page.existed ? updated : created).add(`[[${slug}]]`);
  }
  for await (const row of run.scan("sd:")) {
    const slug = row.k.slice("sd:".length);
    if (((await run.get(`gr:${slug}`)) as GeneratedPageV1 | undefined)?.written === true) continue;
    ((row.v as { created: boolean }).created ? created : updated).add(`[[${slug}]]`);
  }
  return { created, updated };
}

/** The log step: the incumbent `compile` entry. */
async function logRun(run: BatchRun): Promise<void> {
  if (run.counters.compiled === 0 && run.counters.deleted === 0) return;
  const sources = new CappedList();
  for await (const row of run.scan("t:")) if ((row.v as ToExtractV1).kind !== "late") sources.add((row.v as ToExtractV1).file);
  const { created, updated } = await producedLists(run);
  const details: string[] = [];
  if (sources.count > 0) details.push(`Sources: ${sources}`);
  if (created.count > 0) details.push(`Created: ${created}`);
  if (updated.count > 0) details.push(`Updated: ${updated}`);
  if (run.counters.deleted > 0) details.push(`Deleted sources: ${run.counters.deleted}`);
  await appendLog(run.root, "compile", `${sources.count} source(s) → ${created.count + updated.count} page(s)`, { details });
}

/** Run one residual step. */
async function runStep(run: BatchRun, step: ResidualStep): Promise<void> {
  if (step === "catalog") await reconcileCatalogBounded(run);
  else if (step === "index") await generateIndexBounded(run);
  else if (step === "moc") await generateMocBounded(run);
  else await logRun(run);
}

/** The residual phase, from the cursor's step. */
export async function runResidual(run: BatchRun): Promise<void> {
  const from = Math.max(0, STEPS.indexOf((run.meta.cursor.step as ResidualStep | undefined) ?? "catalog"));
  for (let at = from; at < STEPS.length; at += 1) {
    await runStep(run, STEPS[at]!);
    if (at + 1 < STEPS.length) await run.checkpoint({ cursor: { step: STEPS[at + 1] } });
  }
  await run.advance("done");
}

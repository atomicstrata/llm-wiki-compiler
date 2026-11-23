/**
 * @file src/compiler/batch/repair.ts
 * @description The REPAIR phase of a batch compile: the incumbent
 * `repairLinks`, with bounded memory, after resolution's rewrites are applied.
 *
 * SLUGS. Every concept and query page that can be read contributes its
 * lower-cased slug as an occurrence row `rk:<slug>` (counted, so a slug in
 * both namespaces is two occurrences, as in the incumbent candidate list).
 * Pending review candidates contribute nothing: a batch compile refuses
 * before any effect while one is pending.
 *
 * RESOLUTION, the incumbent rule: a link target that names an existing page
 * stays; one shorter than the minimum stays; otherwise it is repaired only
 * when exactly ONE page slug starts with `<target>-` (a range scan of the
 * occurrence rows, stopping at the second).
 *
 * TWO PHASES (`./planned-writes.ts`): every page (concepts, then queries, one
 * at a time) is planned through the incumbent `repairBody` with its targets
 * resolved first, then the planned bytes are applied.
 */

import { CONCEPTS_DIR, QUERIES_DIR } from "../../utils/constants.js";
import { parseFrontmatter, slugify } from "../../utils/markdown.js";
import { rewriteWikilinks } from "../../wiki/wikilinks.js";
import type { CompilePageNamespace } from "../compile-write.js";
import { MIN_REPAIRABLE_SLUG_LENGTH, repairBody, splitWikilink } from "../link-repair.js";
import { scanPages } from "./page-scan.js";
import { applyPlannedRewrites, planRewrite } from "./planned-writes.js";
import type { BatchRun } from "./run-store.js";

/** The page directories repair visits, in the incumbent order. */
const REPAIR_DIRECTORIES: readonly [CompilePageNamespace, string][] = [["concepts", CONCEPTS_DIR], ["queries", QUERIES_DIR]];

/** Record every readable page's lower-cased slug as one occurrence. */
async function recordSlugs(run: BatchRun): Promise<void> {
  for (const [namespace, relDir] of REPAIR_DIRECTORIES) {
    for await (const page of scanPages(run, `rk${namespace}`, relDir)) {
      const key = `rk:${page.slug.toLowerCase()}`;
      await run.put(key, (((await run.get(key)) as number | undefined) ?? 0) + 1);
    }
  }
}

/** The incumbent repair target of `target`, or `null` when it stays. */
async function repairTarget(run: BatchRun, target: string): Promise<string | null> {
  if ((await run.get(`rk:${target}`)) !== undefined || target.length < MIN_REPAIRABLE_SLUG_LENGTH) return null;
  let match: string | null = null;
  let occurrences = 0;
  for await (const row of run.scan(`rk:${target}-`)) {
    occurrences += row.v as number;
    match = row.k.slice("rk:".length);
    if (occurrences > 1) return null;
  }
  return occurrences === 1 ? match : null;
}

/** The repaired body of `body`, or `null` when nothing in it is repaired. */
async function repairedBody(run: BatchRun, body: string): Promise<string | null> {
  const targets = new Set<string>();
  rewriteWikilinks(body, ({ inner }) => { targets.add(slugify(splitWikilink(inner).target)); return undefined; });
  const resolved = new Map<string, string | null>();
  for (const target of targets) resolved.set(target, await repairTarget(run, target));
  const result = repairBody(body, (target) => resolved.get(target) ?? null);
  return result.repaired === 0 ? null : result.body;
}

/** Plan every page's repair, concepts then queries. */
async function planRepairs(run: BatchRun): Promise<void> {
  let planned = 0;
  for (const [namespace, relDir] of REPAIR_DIRECTORIES) {
    for await (const page of scanPages(run, `rp${namespace}`, relDir)) {
      const { body } = parseFrontmatter(page.content);
      const repaired = await repairedBody(run, body);
      if (repaired !== null) await planRewrite(run, "rr", planned++, { namespace, slug: page.slug, content: page.content.replace(body, () => repaired) });
    }
  }
}

/** The repair phase: the slugs, the plan from the current pages, then the planned bytes applied. */
export async function runRepair(run: BatchRun): Promise<void> {
  if (run.meta.cursor.planComplete !== true) {
    await recordSlugs(run);
    await planRepairs(run);
    await run.checkpoint({ cursor: { planComplete: true, applied: -1 } });
  }
  await applyPlannedRewrites(run, "rr", (written) => { run.counters.repaired += written; });
  await run.advance("finalize-state");
}

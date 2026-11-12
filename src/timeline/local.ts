/**
 * @file src/timeline/local.ts
 * @description The timeline step over a local project: compiled sources from
 * the state file, confined reads under the project root, the configured model,
 * and compile's locked page writer. Compile calls {@link generateTimeline} from
 * its finalize stage, after the state flush, so the sources it reads are the
 * ones this compile just recorded.
 *
 * PRECONDITION: the caller holds the project lock (compile does), because the
 * writes go through the lock-free executor core.
 */

import { callClaude } from "../utils/llm.js";
import { diskLocalEntityScans } from "../storage/disk-local-reads.js";
import { collectRawWikiPagesFrom } from "../wiki/collect.js";
import { localDerivedSteps, warnErrors, type DerivedResult } from "../compiler/derived-steps.js";
import { resolveCompileConcurrency } from "../compiler/concurrency.js";
import * as output from "../utils/output.js";
import { listRecordMentions } from "../entities/local.js";
import type { TimelineSchema } from "../schema/types.js";
import { generateTimelineWith, type TimelineSteps } from "./generate.js";

/** The entity type whose records a day lists under "People this day". */
const PEOPLE_TYPE = "person";

/** The timeline steps over the local project at `root`. */
function localTimelineSteps(root: string): TimelineSteps {
  return {
    ...localDerivedSteps(root),
    listConceptPages: async () => (await collectRawWikiPagesFrom(diskLocalEntityScans(root)))
      .filter((page) => page.pageDirectory === "concepts")
      .map((page) => ({ slug: page.slug, title: page.title ?? page.slug, body: page.body })),
    // The entity step has already reported an unreadable registry; a day still gets its page.
    listPeople: () => listRecordMentions(root, PEOPLE_TYPE).catch(() => []),
    complete: (request) => callClaude(request),
  };
}

/**
 * Bring `wiki/timeline/` up to date and report what changed.
 * @param root - Project root; the caller holds its lock.
 * @param timeline - The schema's timeline settings; disabled does nothing.
 * @param concurrency - The compile's `--concurrency`, if given; otherwise the env var or the default.
 */
export async function generateTimeline(root: string, timeline: TimelineSchema, concurrency?: number): Promise<DerivedResult> {
  if (!timeline.enabled) return { written: [], deleted: [], errors: [] };
  output.status("🗓", output.info("Updating the timeline..."));
  const result = await generateTimelineWith(localTimelineSteps(root), { ...timeline, concurrency: resolveCompileConcurrency(concurrency) });
  warnErrors(result);
  if (result.written.length + result.deleted.length > 0) {
    output.status("✓", output.success(`Timeline: ${result.written.length} written, ${result.deleted.length} removed.`));
  }
  return result;
}

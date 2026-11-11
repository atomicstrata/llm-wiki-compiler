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

import path from "path";
import { callClaude } from "../utils/llm.js";
import { readState } from "../utils/state.js";
import { SOURCES_DIR, TIMELINE_DIR } from "../utils/constants.js";
import { diskLocalEntityScans, diskLocalReads } from "../storage/disk-local-reads.js";
import { collectRawWikiPagesFrom } from "../wiki/collect.js";
import { readWikiPageContentOrWarnFrom } from "../compiler/confined-wiki-read.js";
import { applyCompilePageWritesLocked } from "../compiler/compile-write.js";
import { addModelProvenanceMeta } from "../compiler/provenance.js";
import { resolveCompileConcurrency } from "../compiler/concurrency.js";
import * as output from "../utils/output.js";
import type { TimelineSchema } from "../schema/types.js";
import { generateTimelineWith, type TimelineResult, type TimelineSteps } from "./generate.js";

/** The timeline steps over the local project at `root`. */
function localTimelineSteps(root: string): TimelineSteps {
  const reads = diskLocalReads(root);
  return {
    listSources: async () => Object.entries((await readState(root)).sources).map(([file, state]) => ({ file, hash: state.hash })),
    readSource: (file) => reads.readText(path.join(SOURCES_DIR, file)),
    listTimelineSlugs: async () => (await reads.listNames(TIMELINE_DIR).catch(() => []))
      .filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -".md".length)),
    readTimelinePage: (slug) => readWikiPageContentOrWarnFrom(reads, TIMELINE_DIR, slug, false),
    listConceptPages: async () => (await collectRawWikiPagesFrom(diskLocalEntityScans(root)))
      .filter((page) => page.pageDirectory === "concepts")
      .map((page) => ({ slug: page.slug, title: page.title ?? page.slug, body: page.body })),
    complete: (request) => callClaude(request),
    writePages: (writes) => applyCompilePageWritesLocked(root, writes),
    provenance: () => {
      const fields: Record<string, unknown> = {};
      addModelProvenanceMeta(fields);
      return fields;
    },
    now: () => new Date().toISOString(),
  };
}

/**
 * Bring `wiki/timeline/` up to date and report what changed.
 * @param root - Project root; the caller holds its lock.
 * @param timeline - The schema's timeline settings; disabled does nothing.
 */
export async function generateTimeline(root: string, timeline: TimelineSchema): Promise<TimelineResult> {
  if (!timeline.enabled) return { written: [], deleted: [], errors: [] };
  output.status("🗓", output.info("Updating the timeline..."));
  const result = await generateTimelineWith(localTimelineSteps(root), timeline, resolveCompileConcurrency());
  for (const error of result.errors) output.status("!", output.warn(error));
  if (result.written.length + result.deleted.length > 0) {
    output.status("✓", output.success(`Timeline: ${result.written.length} written, ${result.deleted.length} removed.`));
  }
  return result;
}

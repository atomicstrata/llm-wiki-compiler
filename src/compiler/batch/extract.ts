/**
 * @file src/compiler/batch/extract.ts
 * @description The EXTRACT phase of a batch compile: the incumbent
 * `runExtractionPhases`, one checkpointed batch of `t:` rows at a time.
 *
 * Each source goes through the incumbent `extractForSource` (same prompt,
 * same reuse rule, same output), handed a one-source state view and an
 * access whose source read is the bounded confined reader, refusing
 * (`compile_batch_inputs_changed`) when a source's bytes differ from the
 * listing. A batch shares one `pLimit(concurrency)`; a hard failure stops
 * admission, drains the batch's in-flight work and stops the run at the
 * batch's start, so a resume extracts it again.
 *
 * Each result is `x:<seq>` (its concepts, reuse flag, previous concepts and
 * the hash it was extracted from), `xf:<file>`, and one contribution row per
 * concept (`cx:<slug>\0<seq>\0<idx>`): the incumbent merge order.
 *
 * LATE ROUNDS. After every scheduled source of a round is extracted, the
 * slugs that round newly gave its sources reach their other owners, exactly
 * as `findLateAffectedSources` (the spilled walk, `./bfs.ts`, excluding the
 * sources compiled directly, everything already extracted and every detected
 * deletion); they are appended as the next round's `t:` rows, to a fixed point.
 */

import pLimit from "p-limit";
import { slugify } from "../../utils/markdown.js";
import type { ExtractedConcept, SourceState, WikiState } from "../../utils/types.js";
import type { CompileAccess } from "../compile-access.js";
import type { ExtractionResult } from "../deps.js";
import { extractForSource } from "../extraction-phase.js";
import { runLimitedUntilFailure } from "../limited-until-failure.js";
import { BatchCompileError, contributionKey, keySeq, seqKey } from "./contracts.js";
import { compiledDirectly, detectedOf, type ToExtractV1 } from "./closure.js";
import { freshPosition, walkOwners, type WalkPosition } from "./bfs.js";
import type { ListedSourceV1 } from "./detect.js";
import type { BatchRun } from "./run-store.js";
import type { StateSnapshot } from "./state-reads.js";
import { report } from "./report.js";
import { isFailedExtraction } from "./extraction-outcome.js";

/**
 * Most sources one extraction batch holds results for, whatever the
 * configured batch size: each result is bounded by the run row cap, so a
 * batch's results stay within `MAX_EXTRACT_BATCH` rows, and at most
 * `concurrency` source texts (each within the source cap) are in flight.
 */
const MAX_EXTRACT_BATCH = 64;

/** A stored extraction. */
export interface ExtractionRowV1 {
  readonly file: string;
  readonly concepts: ExtractedConcept[];
  readonly reused?: true;
  readonly previousConcepts?: string[];
  /** The hash of the exact text extracted (the listing's hash). */
  readonly hash: string;
  readonly bytes: number;
  readonly round: number;
}

/** What one extraction phase works over. */
export interface ExtractContext {
  readonly run: BatchRun;
  readonly state: StateSnapshot;
  readonly access: CompileAccess;
  readonly concurrency: number;
  /** Whether unchanged sources may reuse their committed extraction this run (the incumbent `reusableSourceFiles` gate). */
  readonly reuseAllowed: boolean;
}

/** A one-source state view for the incumbent extraction. */
function oneSource(state: StateSnapshot, file: string, entry: SourceState | undefined): WikiState {
  return { version: state.meta.version, indexHash: state.meta.indexHash, sources: entry === undefined ? {} : { [file]: entry } };
}

/** Extract one source through the incumbent body. */
async function extractOne(context: ExtractContext, file: string): Promise<ExtractionResult> {
  const entry = await context.state.source(file);
  const detected = await detectedOf(context.run, file);
  const reusable = context.reuseAllowed && detected?.detected === "unchanged" && detected.scoped === "unchanged";
  return extractForSource(context.access, file, { state: oneSource(context.state, file, entry), eligible: new Set(reusable ? [file] : []) });
}

/**
 * Extract `files` under one concurrency limit. A hard failure stops admission,
 * lets the batch's in-flight extractions settle, and only then escapes with
 * the original error, so nothing of the failed batch is recorded or
 * checkpointed and no call is outstanding when the run unwinds.
 */
async function extractLimited(context: ExtractContext, files: string[]): Promise<ExtractionResult[]> {
  return runLimitedUntilFailure(pLimit(context.concurrency), files, (file) => extractOne(context, file));
}

/** A listed source whose bytes were hashed (a listed source with a null hash was unreadable at listing time). */
type HashedListedSource = ListedSourceV1 & { readonly hash: string };

/** The run's listing entry for `file`, refusing (`compile_batch_inputs_changed`) when it is absent or was unreadable. */
async function listedSourceOf(run: BatchRun, file: string): Promise<HashedListedSource> {
  const listed = (await run.get(`f:${file}`)) as ListedSourceV1 | undefined;
  if (listed?.hash === null || listed === undefined) throw new BatchCompileError("compile_batch_inputs_changed", `source ${file.slice(0, 80)} was not in the run's listing`);
  return { hash: listed.hash, bytes: listed.bytes };
}

/** The stored row of one extraction: optional fields appear only when set, in this order. */
function extractionRow(result: ExtractionResult, listed: HashedListedSource, round: number): ExtractionRowV1 {
  return {
    file: result.sourceFile, concepts: result.concepts, hash: listed.hash, bytes: listed.bytes, round,
    ...(result.reused ? { reused: true as const } : {}), ...(result.previousConcepts === undefined ? {} : { previousConcepts: result.previousConcepts }),
  };
}

/** The incumbent result's error for a source whose extraction failed. */
async function reportExtractionOutcome(run: BatchRun, result: ExtractionResult): Promise<void> {
  if (isFailedExtraction(result)) { run.counters.failed += 1; await report(run, { kind: "error", file: result.sourceFile, message: `No concepts extracted from ${result.sourceFile}` }); }
}

/** Record one extraction and its contributions. */
async function recordExtraction(run: BatchRun, seq: number, round: number, result: ExtractionResult): Promise<void> {
  const listed = await listedSourceOf(run, result.sourceFile);
  await run.put(seqKey("x:", seq), extractionRow(result, listed, round));
  await run.put(`xf:${result.sourceFile}`, seq);
  for (let idx = 0; idx < result.concepts.length; idx += 1) await run.put(contributionKey(slugify(result.concepts[idx]!.concept), seq, idx), 1);
  run.counters.extracted += 1;
  if (result.reused) run.counters.reused += 1;
  await reportExtractionOutcome(run, result);
}

/** Extract every scheduled source after the cursor, one checkpointed batch at a time. */
async function extractScheduled(context: ExtractContext): Promise<void> {
  const { run } = context;
  let batch: { seq: number; row: ToExtractV1 }[] = [];
  const flush = async (): Promise<void> => {
    const results = await extractLimited(context, batch.map((item) => item.row.file));
    for (let at = 0; at < batch.length; at += 1) await recordExtraction(run, batch[at]!.seq, batch[at]!.row.round, results[at]!);
    await run.checkpoint({ cursor: { ...run.meta.cursor, after: batch[batch.length - 1]!.seq } });
    batch = [];
  };
  const after = (run.meta.cursor.after as number | undefined) ?? -1;
  const size = Math.min(run.meta.batchSize, MAX_EXTRACT_BATCH);
  for await (const row of run.scan("t:", seqKey("t:", after + 1))) {
    batch.push({ seq: keySeq("t:", row.k), row: row.v as ToExtractV1 });
    if (batch.length >= size) await flush();
  }
  if (batch.length > 0) await flush();
}

/** The late-discovery walk of round `round`: seeds are the live owners of the slugs that round newly gave its sources. */
function lateWalk(context: ExtractContext, round: number): Parameters<typeof walkOwners>[2] {
  const { run, state } = context;
  const ns = `l${round}:`;
  return {
    ns,
    excluded: async (file) => {
      const detected = await detectedOf(run, file);
      return compiledDirectly(detected) || detected?.detected === "deleted" || (await run.get(`xf:${file}`)) !== undefined;
    },
    seed: async (_queue, affect) => {
      for await (const row of run.scan("x:")) {
        const extraction = row.v as ExtractionRowV1;
        if (extraction.round !== round) continue;
        const old = new Set((await state.source(extraction.file))?.concepts ?? []);
        for (const concept of extraction.concepts) {
          const slug = slugify(concept.concept);
          if (old.has(slug) || (await run.get(`${ns}fs:${slug}`)) !== undefined) continue;
          await run.put(`${ns}fs:${slug}`, 1);
          for await (const owner of state.owners(slug)) await affect(owner);
        }
      }
    },
    save: (position) => run.checkpoint({ cursor: { ...run.meta.cursor, late: position } }),
  };
}

/** Schedule round `round + 1` from the late walk; returns how many sources it scheduled. */
async function scheduleLateRound(context: ExtractContext, round: number): Promise<number> {
  const { run } = context;
  const position = (run.meta.cursor.late as WalkPosition | undefined) ?? freshPosition();
  const found = await walkOwners(run, context.state, lateWalk(context, round), position);
  let seq = run.counters.toExtract;
  for await (const row of run.scan(`l${round}:a:`)) await run.put(seqKey("t:", seq++), { file: row.v as string, round: round + 1, kind: "late" });
  run.counters.toExtract = seq;
  return found;
}

/** The extract phase: every round to a fixed point. */
export async function runExtraction(context: ExtractContext): Promise<void> {
  const { run } = context;
  for (;;) {
    await extractScheduled(context);
    const round = (run.meta.cursor.round as number | undefined) ?? 0;
    const scheduled = await scheduleLateRound(context, round);
    if (scheduled === 0) break;
    await run.checkpoint({ cursor: { after: run.meta.cursor.after, round: round + 1 } });
  }
  await run.advance("freeze");
}

/**
 * @file test/scale-measure/child.ts
 * @description One measurement child: a fresh Node process that runs ONE
 * build phase or ONE measured operation against a project on real disk and
 * prints one JSON line.
 *
 * Before any work it installs the process-wide file-system observer and the
 * offline embedding double. Each pass (a cold one, then warm ones in the same
 * process) records its elapsed time, the indexed stores' segment counters
 * (ambient, so every store the work opens is counted), the observer's
 * per-area tallies and the embedding texts answered. The process reports its
 * isolated `maxRSS` and a sampled heap and RSS high-water.
 */

import { performance } from "node:perf_hooks";
import { newCounters, observeIo } from "../../src/segments/counters.js";
import { BUILD_PHASES, type CorpusShape } from "./corpus.js";
import { embeddingCalls, installEmbeddingDouble } from "./embedding-double.js";
import { fsTallies, installFsObserver, resetFsTallies } from "./fs-observer.js";
import { MEASURED_OPS } from "./ops.js";
import { startSampler } from "./sampler.js";

/** What the driver asks a child to do. */
export interface ChildRequest {
  readonly mode: "build" | "op";
  readonly name: string;
  readonly root: string;
  readonly shape: CorpusShape;
  readonly dimensions: number;
  readonly passes: number;
}

/** Run one pass of `work`, measured. */
async function measuredPass(work: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  resetFsTallies();
  const counters = newCounters();
  const texts = embeddingCalls.texts;
  const started = performance.now();
  const result = await observeIo(counters, work);
  const ms = performance.now() - started;
  return { ms, counters: { ...counters }, fs: JSON.parse(JSON.stringify(fsTallies)) as unknown, embeddedTexts: embeddingCalls.texts - texts, result };
}

/** The work a request names. */
function workFor(request: ChildRequest): (pass: number) => Promise<Record<string, unknown>> {
  if (request.mode === "build") {
    const phase = BUILD_PHASES[request.name];
    if (phase === undefined) throw new Error(`unknown build phase ${request.name}`);
    return () => phase(request.root, request.shape);
  }
  const op = MEASURED_OPS[request.name];
  if (op === undefined) throw new Error(`unknown operation ${request.name}`);
  return (pass) => op.run(request.root, request.shape, pass);
}

/** Run the request and print its measurement. */
async function main(): Promise<void> {
  const request = JSON.parse(process.argv[2]!) as ChildRequest;
  installFsObserver(request.root);
  installEmbeddingDouble(request.dimensions);
  const work = workFor(request);
  const stop = startSampler();
  const runs: Array<Record<string, unknown>> = [];
  for (let pass = 0; pass < request.passes; pass += 1) runs.push(await measuredPass(() => work(pass)));
  const peaks = stop();
  const maxRssKiB = process.resourceUsage().maxRSS;
  console.log(JSON.stringify({ mode: request.mode, name: request.name, runs, maxRssKiB, ...peaks, node: process.version }));
}

await main();

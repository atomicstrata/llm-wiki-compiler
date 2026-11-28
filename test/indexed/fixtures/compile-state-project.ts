/**
 * @file test/indexed/fixtures/compile-state-project.ts
 * @description A vitest-free fixture shared by the indexed tests' child
 * processes: a small corpus and a sample `state.json`, prepared `local-indexed`
 * WITH the `segmented-compile-state-1` capability through the real
 * set-and-prepare bodies (the state imported into the segmented compile state).
 */

import { diskScaleTransitionSteps, setExpectedScaleWith } from "../../../src/scale/transition.js";
import { writeState } from "../../../src/utils/state.js";
import { writeCorpus } from "../../catalog/helpers.js";
import { sampleState } from "../../cstate/sample-state.js";

/** The fixture corpus: pages and sources. */
const CORPUS_PAGES = 4;
const CORPUS_SOURCES = 3;
/** The expected scale the fixture requests (an indexed plan). */
const REQUESTED_DOCUMENTS = 8_000;

/** Prepare `root` indexed with the segmented compile state imported from a sample `state.json`; returns the readiness. */
export async function prepareCompileStateProject(root: string): Promise<string> {
  await writeCorpus(root, CORPUS_PAGES, CORPUS_SOURCES);
  await writeState(root, sampleState());
  const steps = { ...diskScaleTransitionSteps(root), preflight: { freeBytes: async () => Number.MAX_SAFE_INTEGER } };
  return (await setExpectedScaleWith(steps, { request: { documents: REQUESTED_DOCUMENTS }, capabilities: ["segmented-compile-state-1"] })).readiness;
}

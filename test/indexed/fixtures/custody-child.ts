/**
 * @file test/indexed/fixtures/custody-child.ts
 * @description A child process that builds the custody-bearing project shape
 * the maintenance-acquisition tests need, so the test process itself never
 * reads (or leases) the fixture's stores.
 *
 * Mode `build <root> <documents> <applied|parked>`: a corpus of `documents`
 * pages; one REAL operation bundle in the `research` workspace through the
 * incumbent executor, either applied to `succeeded` or parked at
 * `recovery-required` by an apply-time authority outage; one workspace
 * catalog record through the incumbent catalog writer; then `local-indexed`
 * activated (its workspace catalog imported into a segmented store), then
 * nine page edits each followed by a real catalog sync, so the page catalog
 * leaves superseded segments for a collection.
 * Mode `park <root>`: park one more bundle (a different source) on the
 * already indexed project.
 * Mode `cstate <root>`: a small corpus and a `state.json`, then prepared
 * `local-indexed` WITH the `segmented-compile-state-1` capability (the state
 * imported into the segmented compile state).
 * Mode `run <root> <active|done>`: a batch compile run store, left active or
 * advanced to `done` (prints its run id).
 * Prints one JSON line: the outcome, or the error code.
 */

import { appendCatalogRecordLocked, createCatalogRecord } from "../../../src/operation-bundles/catalog-store.js";
import { approveAndApplyOperationBundleLocked } from "../../../src/operation-bundles/executor.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { catalogSync } from "../../../src/catalog/facade.js";
import { activateIndexed, writeCorpus } from "../../catalog/helpers.js";
import { approveRequest, buildRuntime, parkedSourceBundle, stageSourceBundle, WORKSPACE } from "../../operation-bundles/executor-fixtures.js";
import { prepareCompileStateProject } from "./compile-state-project.js";
import { BatchRun } from "../../../src/compiler/batch/run-store.js";

/** Edit-and-sync rounds that leave superseded catalog segments for a collection. */
const SUPERSEDING_SYNCS = 9;
/** Source files of the corpus. */
const CORPUS_SOURCES = 4;

/** Build the project at `root`. */
async function build(root: string, documents: number, bundle: string): Promise<unknown> {
  await writeCorpus(root, documents, CORPUS_SOURCES);
  if (bundle === "parked") await parkedSourceBundle(root);
  else await approveAndApplyOperationBundleLocked(root, approveRequest(await stageSourceBundle(root), buildRuntime()));
  const record = createCatalogRecord({ logicalRecordId: "l-custody", mutationId: `opm_${"c".repeat(64)}`, payload: {}, createdAt: "2026-10-27T00:00:00.000Z" });
  if (await appendCatalogRecordLocked(root, WORKSPACE, record) !== "created") throw new Error("the workspace catalog record was not created");
  await activateIndexed(root);
  for (let at = 0; at < SUPERSEDING_SYNCS; at += 1) {
    await writeFile(path.join(root, "wiki", "concepts", "page-00000.md"), `---\ntitle: Page 0 edit ${at}\n---\nEdited ${at}.\n`);
    await catalogSync(root);
  }
  return { built: true };
}

/** Prepare `root` indexed with the segmented compile state imported from a sample `state.json`. */
async function withCompileState(root: string): Promise<unknown> {
  return { readiness: await prepareCompileStateProject(root) };
}

/** Create a batch compile run of `root`, advanced to `done` unless `state` is `active`. */
async function batchRun(root: string, state: string): Promise<unknown> {
  const run = await BatchRun.create(root, { batchSize: 10, embeddings: false, identity: { policy: "p", sources: null, cstate: "c" } });
  if (state !== "active") await run.advance("done");
  return { runId: run.runId };
}

/** The modes, by name. */
const MODES: Record<string, (args: string[]) => Promise<unknown>> = {
  build: ([root, documents, bundle]) => build(root!, Number(documents), bundle!),
  park: async ([root]) => { await parkedSourceBundle(root!, Buffer.from("parked after the backup\n")); return { parked: true }; },
  cstate: ([root]) => withCompileState(root!),
  run: ([root, state]) => batchRun(root!, state!),
};

try {
  const [mode, ...args] = process.argv.slice(2);
  if (MODES[mode!] === undefined) throw new Error(`unknown mode ${mode}`);
  const result = await MODES[mode!]!(args);
  console.log(JSON.stringify({ outcome: "ok", result }));
} catch (error) {
  const { code } = error as { code?: unknown };
  console.log(JSON.stringify({ outcome: typeof code === "string" ? code : String(error), message: error instanceof Error ? error.message : String(error) }));
}

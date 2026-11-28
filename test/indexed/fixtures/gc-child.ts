/**
 * @file test/indexed/fixtures/gc-child.ts
 * @description A child process for collection tests, so every collector and
 * every held reader is a REAL separate process with its own reader lease.
 *
 * Modes (arguments after the script):
 * - `apply <root> <planFile> [censusFile goFile]`: apply the saved plan with
 *   `readersOffline`; with the two files, announce after the reader census and
 *   wait for the go file (the registration/collection race seam).
 * - `hold <root> <store> <readyFile> <goFile>`: open the store and read every
 *   row, announce, wait for the go file, then read every row AGAIN through the
 *   same snapshot; prints both reads.
 * - `read <root> <store>`: open the store and print every row.
 * - `build <root> [store...]`: activate `local-indexed` on a fresh project,
 *   then make each store (default `gcfix`) leave superseded segments (nine
 *   one-row commits: the eighth merges the first eight runs).
 * - `commit <root> <store> <key>`: commit one more row.
 * Each mode prints one JSON line: the outcome, or the error code.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { applyGc } from "../../../src/indexed/gc.js";
import { activateIndexed } from "../../catalog/helpers.js";
import { diskSegmentStoreIo } from "../../../src/segments/io.js";
import { SegmentStore } from "../../../src/segments/store.js";
import { runChildModes } from "./child-main.js";

/** Wait until `file` exists. */
async function waitFor(file: string): Promise<void> {
  while (!existsSync(file)) await sleep(10);
}

/** Every live row of `snapshot`. */
async function rows(snapshot: SegmentStore): Promise<Record<string, unknown>> {
  const all: Record<string, unknown> = {};
  for await (const row of snapshot.scan()) all[row.k] = row.v;
  return all;
}

/** Commit one row `key` to `store`. */
async function commitRow(root: string, store: string, key: string): Promise<void> {
  await (await SegmentStore.open(diskSegmentStoreIo(root, store))).commit({ rows: [{ k: key, v: key.toUpperCase() }] });
}

/** Activate the project and give each of `stores` (default `gcfix`) superseded segments. */
async function build(root: string, stores: string[]): Promise<unknown> {
  await activateIndexed(root);
  for (const store of stores.length === 0 ? ["gcfix"] : stores) for (let at = 0; at < 9; at += 1) await commitRow(root, store, `k${at}`);
  return { built: true };
}

/** Apply a saved plan, optionally pausing after the reader census. */
function apply([root, planFile, censusFile, goFile]: string[]): Promise<unknown> {
  const seam = censusFile === undefined ? {} : { afterCensusForTest: async () => { writeFileSync(censusFile, "censused"); await waitFor(goFile!); } };
  return applyGc(root!, JSON.parse(readFileSync(planFile!, "utf8")), { readersOffline: true, ...seam });
}

/** Read every row; for `hold`, announce, wait, and read again through the same snapshot. */
async function readRows(hold: boolean, [root, store, readyFile, goFile]: string[]): Promise<unknown> {
  const snapshot = await SegmentStore.open(diskSegmentStoreIo(root!, store!));
  const first = await rows(snapshot);
  if (!hold) return { rows: first };
  writeFileSync(readyFile!, "ready");
  await waitFor(goFile!);
  return { first, second: await rows(snapshot) };
}

/** The modes, by name. */
const MODES: Record<string, (args: string[]) => Promise<unknown>> = {
  build: (args) => build(args[0]!, args.slice(1)),
  commit: async ([root, store, key]) => { await commitRow(root!, store!, key!); return { committed: key }; },
  apply,
  hold: (args) => readRows(true, args),
  read: (args) => readRows(false, args),
};

await runChildModes(MODES);

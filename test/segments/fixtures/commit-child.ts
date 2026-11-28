/**
 * @file test/segments/fixtures/commit-child.ts
 * @description A child process that opens a store, announces it has read the
 * manifest, waits for a go file, then commits one row; it prints the outcome.
 * Used to witness conditional publication between real processes.
 */

import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { IndexedStoreError } from "../../../src/segments/contracts.js";
import { diskSegmentStoreIo } from "../../../src/segments/io.js";
import { SegmentStore } from "../../../src/segments/store.js";

/** Open, signal, wait, commit, report. */
async function main(): Promise<void> {
  const [root, store, key, readyFile, goFile] = process.argv.slice(2) as [string, string, string, string, string];
  const snapshot = await SegmentStore.open(diskSegmentStoreIo(root, store));
  writeFileSync(readyFile, "ready");
  while (!existsSync(goFile)) await sleep(10);
  try {
    await snapshot.commit({ rows: [{ k: key, v: process.pid }] });
    console.log(JSON.stringify({ outcome: "committed" }));
  } catch (error) {
    console.log(JSON.stringify({ outcome: error instanceof IndexedStoreError ? error.code : String(error) }));
  }
}

await main();

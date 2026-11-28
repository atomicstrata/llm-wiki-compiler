/**
 * @file test/indexed/fixtures/restore-child.ts
 * @description A child process for indexed-authority backup and restore
 * tests: every restore must run in a FRESH process, and every held reader is
 * a real separate process with its own lease.
 *
 * Modes (arguments after the script):
 * - `activate <root>`: a small corpus, then `local-indexed` activated.
 * - `backup <root> <dir>`: make an indexed-authority backup.
 * - `restore <root> <dir> [pausedFile]`: restore with `readersOffline`; with a
 *   paused file, announce after installing files and wait forever, keeping the
 *   process alive (a parent SIGKILLs it).
 * - `restore-probe <root> <dir> <pausedFile>`: restore pausing after files
 *   while an IN-PROCESS listing and readiness check, scheduled outside the
 *   restore's scope, run; prints what they saw, then lets the restore finish.
 * - `restore-cli <root> <dir>`: `llmwiki catalog restore <dir> --readers-offline
 *   --json` run from `root`; prints its exit code and envelope.
 * - `verify <root>`: full verification; `list <root>`: one page listing.
 * - `hold <root> <readyFile> <goFile>`: hold a catalog snapshot until go.
 * Each mode prints one JSON line: the outcome, or the error code.
 */

import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { routedListPages } from "../../../src/catalog/routes.js";
import { catalogRestoreCommand } from "../../../src/commands/catalog-maintenance.js";
import { createIndexedBackup } from "../../../src/indexed/backup.js";
import { restoreIndexedBackup } from "../../../src/indexed/restore.js";
import { verifyIndexedStores } from "../../../src/indexed/verify.js";
import { assertScaleReady } from "../../../src/scale/gate.js";
import { diskSegmentStoreIo } from "../../../src/segments/io.js";
import { SegmentStore } from "../../../src/segments/store.js";
import { activateIndexed, writeCorpus } from "../../catalog/helpers.js";

/** Wait until `file` exists. */
async function waitFor(file: string): Promise<void> {
  while (!existsSync(file)) await sleep(10);
}

/** The code of a refusal, or its message. */
const codeOf = (error: unknown): string => {
  const { code, block } = error as { code?: unknown; block?: unknown };
  return typeof code === "string" ? code : typeof block === "string" ? block : String(error);
};

/** Restore while an in-process probe, scheduled outside the restore's scope, lists and checks readiness during the pause. */
async function restoreProbe([root, dir, paused]: string[]): Promise<unknown> {
  const seen: Record<string, string> = {};
  let signal!: (started: boolean) => void;
  const announced = new Promise<boolean>((resolve) => { signal = resolve; });
  // Schedule outside the restore's private access scope; a pre-seam refusal
  // resolves `announced` as false, leaving no polling timer alive.
  const probe = new Promise<void>((resolve, reject) => setTimeout(() => {
    void announced.then(async (started) => {
      if (!started) return;
      seen.list = await routedListPages(root!).then(() => "listed", codeOf);
      seen.ready = await assertScaleReady(root!).then(() => "ready", codeOf);
    }).then(resolve, reject);
  }, 0));
  try {
    const receipt = await restoreIndexedBackup(root!, dir!, {
      readersOffline: true,
      afterInstallFilesForTest: async () => { writeFileSync(paused!, "paused"); signal(true); await probe; },
    });
    return { seen, resumed: receipt.resumed };
  } finally {
    signal(false);
  }
}

/** Run the restore CLI from `root`, capturing the envelope it prints. */
async function restoreCli([root, dir]: string[]): Promise<unknown> {
  process.chdir(root!);
  let printed = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
  try {
    const exit = await catalogRestoreCommand(dir!, { json: true, readersOffline: true });
    return { exit, envelope: JSON.parse(printed) as unknown };
  } finally {
    process.stdout.write = write;
  }
}

/** The modes, by name. */
const MODES: Record<string, (args: string[]) => Promise<unknown>> = {
  activate: async ([root]) => { await writeCorpus(root!, 6, 4); await activateIndexed(root!); return { activated: true }; },
  backup: ([root, dir]) => createIndexedBackup(root!, dir!),
  restore: ([root, dir, paused]) => restoreIndexedBackup(root!, dir!, {
    readersOffline: true, ...(paused === undefined ? {} : { afterInstallFilesForTest: async () => { writeFileSync(paused, "paused"); await new Promise(() => { setInterval(() => {}, 1000); }); } }),
  }),
  "restore-probe": restoreProbe,
  "restore-cli": restoreCli,
  verify: async ([root]) => { const report = await verifyIndexedStores(root!); return { ok: report.ok, failed: report.stores.filter((s) => !s.ok).map((s) => s.store) }; },
  list: async ([root]) => ({ pages: (await routedListPages(root!)).pages.length }),
  hold: async ([root, ready, go]) => { await SegmentStore.open(diskSegmentStoreIo(root!, "catalog")); writeFileSync(ready!, "ready"); await waitFor(go!); return { held: true }; },
};

try {
  console.log(JSON.stringify({ outcome: "ok", result: await MODES[process.argv[2]!]!(process.argv.slice(3)) }));
} catch (error) {
  console.log(JSON.stringify({ outcome: codeOf(error), message: error instanceof Error ? error.message : String(error) }));
}

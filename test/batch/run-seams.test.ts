/**
 * @file test/batch/run-seams.test.ts
 * @description Batch compile run stores against the indexed-authority
 * backup and restore (each backup, restore and run made in a CHILD process
 * that exits first, so the test process holds no reader lease of a fixture): an
 * active run refuses the backup; a finished run is DERIVED state, left out of
 * the backup and kept (its report readable) by the restore; a run store whose
 * meta cannot be read refuses the backup rather than being skipped. The
 * restore (already the collector, so it reads run metas WITHOUT a reader
 * lease) refuses an active run and an unreadable run meta before any marker.
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeAll } from "../config/storage-profile-hooks.js";
import { readReport } from "../../src/compiler/batch/report.js";
import { runChild } from "../helpers-child-process.js";
import { backedUp, child, cleanup, compileStateProject, custodyChild, markerPresent, owned, restoreChild } from "../indexed/restore-helpers.js";

/** Child chains of real durable writes on the external disk; measured, explicit. */
const CHILD_CHAIN_TIMEOUT_MS = 300_000;
beforeAll(async () => {
  await restoreChild();
  await custodyChild();
}, CHILD_CHAIN_TIMEOUT_MS);
afterEach(cleanup);

/** A new run of `root` made in a child, left `active` or advanced to `done`; returns its run id. */
async function newRun(root: string, state: "active" | "done" = "active"): Promise<string> {
  const end = await runChild(await custodyChild(), ["run", root, state]);
  expect(end.json?.outcome, end.stderr).toBe("ok");
  return (end.json!.result as { runId: string }).runId;
}

/** Try a backup of `root` in a child; returns its outcome and message. */
async function tryBackup(root: string): Promise<{ outcome: unknown; message: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "llmwiki-run-seams-backup-"));
  owned.push(dir);
  const made = await child("backup", root, dir);
  return { outcome: made.outcome, message: String(made.message) };
}

/** Give `root` a run store whose meta cannot be read (a manifest that is not one). */
async function unreadableRun(root: string): Promise<void> {
  const store = path.join(root, ".llmwiki", "indexed", "crun-0123456789ab");
  await mkdir(store, { recursive: true });
  await writeFile(path.join(store, "manifest.json"), "{}");
}

describe("batch compile run stores and the indexed backup", () => {
  it("refuse the backup while a run is active", async () => {
    const root = await compileStateProject("run-seams");
    await newRun(root);
    const made = await tryBackup(root);
    expect(made.outcome).not.toBe("ok");
    expect(made.message).toContain("a batch compile run is active");
  }, CHILD_CHAIN_TIMEOUT_MS);

  it("leave a finished run out of the backup, and the restore keeps it readable", async () => {
    const root = await compileStateProject("run-seams");
    const runId = await newRun(root, "done");
    const dir = await backedUp(root);
    const index = JSON.parse(await readFile(path.join(dir, "backup.json"), "utf8")) as { stores: { store: string }[] };
    expect(index.stores.map((entry) => entry.store).filter((store) => store.startsWith("crun-"))).toEqual([]);
    const restored = await child("restore", root, dir);
    expect(restored.outcome, String(restored.message)).toBe("ok");
    expect(existsSync(path.join(root, ".llmwiki", "indexed", `crun-${runId}`))).toBe(true);
    expect((await readReport(root, runId)).phase).toBe("done");
  }, CHILD_CHAIN_TIMEOUT_MS);

  it("refuse the backup when a run store's meta cannot be read", async () => {
    const root = await compileStateProject("run-seams");
    await unreadableRun(root);
    const made = await tryBackup(root);
    expect(made.outcome).not.toBe("ok");
  }, CHILD_CHAIN_TIMEOUT_MS);
});

describe("batch compile run stores and the indexed restore", () => {
  it("refuse the restore while a run is active, before any marker", async () => {
    const root = await compileStateProject("run-seams");
    const dir = await backedUp(root);
    await newRun(root);
    const restored = await child("restore", root, dir);
    expect(restored.outcome).not.toBe("ok");
    expect(String(restored.message)).toContain("a batch compile run is active");
    expect(markerPresent(root)).toBe(false);
  }, CHILD_CHAIN_TIMEOUT_MS);

  it("refuse the restore when a run store's meta cannot be read, before any marker", async () => {
    const root = await compileStateProject("run-seams");
    const dir = await backedUp(root);
    await unreadableRun(root);
    const restored = await child("restore", root, dir);
    expect(restored.outcome).not.toBe("ok");
    expect(String(restored.message)).not.toContain("indexed_reader_lease_unavailable");
    expect(markerPresent(root)).toBe(false);
  }, CHILD_CHAIN_TIMEOUT_MS);
});

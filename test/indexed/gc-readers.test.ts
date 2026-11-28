/**
 * @file test/indexed/gc-readers.test.ts
 * @description Collection against REAL reader processes. A live reader's
 * lease refuses an apply; a SIGKILLed reader's lease is stale and ignored; a
 * lease that cannot be classified (malformed, another host) refuses. A reader
 * that registers AFTER the census reads the current, protected manifest and
 * keeps reading through the same snapshot after the deletion. In this
 * process: an apply refuses once the process has read the stores, and no
 * snapshot may be opened while it collects.
 *
 * The shared base every case copies is built in `beforeAll`, under that hook's
 * own named bound, so no case spends its budget on the base build.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterAll, afterEach, beforeAll } from "../config/storage-profile-hooks.js";
import { applyGc } from "../../src/indexed/gc.js";
import { diskSegmentStoreIo } from "../../src/segments/io.js";
import { SegmentStore } from "../../src/segments/store.js";
import type { ChildProcess } from "node:child_process";
import { childEnd, startChild, type ChildEnd } from "../helpers-child-process.js";
import { builtProject, gcMode as child, gcChild, savedPlan, storeLeaves, waitFor, removeBases } from "./gc-helpers.js";

const ROWS = Object.fromEntries(Array.from({ length: 9 }, (_, at) => [`k${at}`, `K${at}`]));
/**
 * The NAMED bound of this file's setup hook only: bundling the child and building
 * the shared base (real activation, nine durable commits, real compaction, in a
 * child process). A 300 s bound failed at checkpoint 30: that base build took
 * about 375 s at about 1.83 s per fsync on the slow durable test volume (about
 * 0.86 s per fsync at checkpoint 29). A pass under this bound shows the
 * behaviour, not the reference 30 s or slow-profile 90 s budget, and not
 * throughput. Each case keeps the profile's own budget.
 */
const GC_BASE_SETUP_TIMEOUT_MS = 900_000;
const roots: string[] = [];
/** Children this file started: always killed and awaited after each test, even after a failure. */
const owned: { readonly process: ChildProcess; readonly ended: Promise<unknown> }[] = [];
beforeAll(async () => { await gcChild(); await prewarmBase(); }, GC_BASE_SETUP_TIMEOUT_MS);
afterAll(removeBases);
afterEach(async () => {
  for (const { process: owner, ended } of owned.splice(0)) { if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL"); await ended; }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/**
 * Build this file's shared base before any case starts, through the existing
 * `builtProject`. Its one warm copy is made inside a holder this hook owns and
 * removes, even when the build fails; the base itself stays for the cases and
 * `removeBases`.
 */
async function prewarmBase(): Promise<void> {
  const holder = await mkdtemp(path.join(os.tmpdir(), "llmwiki-gcr-warm-"));
  try {
    await builtProject(`${path.relative(os.tmpdir(), holder)}${path.sep}copy-`);
  } finally {
    await rm(holder, { recursive: true, force: true });
  }
}

/** Start a child owned by this test. */
async function ownedChild(args: string[]): Promise<{ process: ChildProcess; ended: Promise<ChildEnd> }> {
  const started = startChild(await gcChild(), args);
  const entry = { process: started, ended: childEnd(started) };
  owned.push(entry);
  return entry;
}

/** A built project, removed after the test. */
async function project(): Promise<string> {
  const root = await builtProject("llmwiki-gcr-");
  roots.push(root);
  return root;
}

/** Start a reader that holds a gcfix snapshot until `go` exists. */
async function holdReader(root: string, tag: string) {
  const ready = path.join(root, `${tag}.ready`);
  const go = path.join(root, `${tag}.go`);
  const { process: reader, ended } = await ownedChild(["hold", root, "gcfix", ready, go]);
  await waitFor(ready);
  return { reader, ended, go };
}

/** Write a lease leaf by hand. */
async function writeLease(root: string, name: string, body: string): Promise<void> {
  await mkdir(path.join(root, ".llmwiki", "indexed-readers"), { recursive: true });
  await writeFile(path.join(root, ".llmwiki", "indexed-readers", name), body);
}

describe("reader leases of other processes", () => {
  it("a live reader refuses the apply; after it exits the same plan applies", async () => {
    const root = await project();
    const { planFile } = await savedPlan(root);
    const held = await holdReader(root, "live");
    const before = await storeLeaves(root, "gcfix");
    expect((await child("apply", root, planFile)).outcome).toBe("indexed_gc_readers_active");
    expect(await storeLeaves(root, "gcfix")).toEqual(before);
    await writeFile(held.go, "go");
    expect((await held.ended).json?.outcome).toBe("ok");
    expect((await child("apply", root, planFile)).outcome).toBe("ok");
  });

  it("a SIGKILLed reader's lease is stale and ignored", async () => {
    const root = await project();
    const held = await holdReader(root, "killed");
    held.reader.kill("SIGKILL");
    await held.ended;
    const { planFile } = await savedPlan(root);
    const applied = await child("apply", root, planFile);
    expect(applied.outcome).toBe("ok");
    expect((applied.result as { staleLeases: number }).staleLeases).toBeGreaterThanOrEqual(1);
  });

  it("a malformed lease, or one from another host, refuses", async () => {
    const tag = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 8);
    for (const [name, body] of [[`${tag}-${process.pid}-0000abcd.lease`, "not json"], [`0badc0de-${process.pid}-0000abcd.lease`, "{}"]] as const) {
      const root = await project();
      await writeLease(root, name, body);
      const { planFile } = await savedPlan(root);
      expect((await child("apply", root, planFile)).outcome).toBe("indexed_gc_readers_active");
    }
  });
});

describe("the registration/collection race", () => {
  it("a reader registering after the census reads the current manifest through the deletion", async () => {
    const root = await project();
    const { planFile } = await savedPlan(root);
    const censused = path.join(root, "censused");
    const applyGo = path.join(root, "apply.go");
    const collector = (await ownedChild(["apply", root, planFile, censused, applyGo])).ended;
    await waitFor(censused);
    const held = await holdReader(root, "late");
    await writeFile(applyGo, "go");
    expect((await collector).json?.outcome).toBe("ok");
    await writeFile(held.go, "go");
    const read = (await held.ended).json?.result as { first: unknown; second: unknown };
    expect([read.first, read.second]).toEqual([ROWS, ROWS]);
  });
});

describe("in this process", () => {
  it("an apply refuses once this process has read the stores", async () => {
    const root = await project();
    const { preview } = await savedPlan(root);
    await SegmentStore.open(diskSegmentStoreIo(root, "gcfix"));
    await expect(applyGc(root, preview.plan, { readersOffline: true })).rejects.toThrow(/indexed_reader_lease_unavailable: this process has already read/);
  });

  it("no snapshot may be opened while this process collects", async () => {
    const root = await project();
    const { preview } = await savedPlan(root);
    let opened: unknown = "not attempted";
    const seam = async () => { opened = await SegmentStore.open(diskSegmentStoreIo(root, "gcfix")).then(() => "opened", (error: Error) => error.message); };
    await applyGc(root, preview.plan, { readersOffline: true, afterCensusForTest: seam });
    expect(String(opened)).toMatch(/indexed_reader_lease_unavailable: this process is collecting/);
  });
});

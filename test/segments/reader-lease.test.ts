/**
 * @file test/segments/reader-lease.test.ts
 * @description The reader-lease protocol in one process, on real disk. A
 * project without `.llmwiki/indexed` registers nothing; the first manifest
 * read of an indexed project publishes ONE complete lease, reused after; the
 * FIRST commit that creates a store registers before its manifest is
 * published; a lease that cannot be published refuses the read; a lease that
 * vanished (the root recreated at the same path) refuses later reads.
 *
 * Publication is not fsynced (see `publishLease`): a normal publication leaves
 * exactly one 0600 lease in a 0700 directory and no scratch leaf, and the
 * writer's random-suffix scratch left by a crashed (dead-pid) writer stays
 * `uncertain` and in place, which `applyGc` refuses on
 * (`test/indexed/gc-readers.test.ts` covers that refusal for unclassifiable leaves).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { diskSegmentStoreIo } from "../../src/segments/io.js";
import { readerCensus } from "../../src/segments/reader-lease.js";
import { SegmentStore } from "../../src/segments/store.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-lease-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const READERS = () => path.join(root, ".llmwiki", "indexed-readers");
/** The permission bits of a file mode. */
const PERMISSION_BITS = 0o777;

/** The lease leaves under `root`. */
async function leases(): Promise<string[]> {
  return existsSync(READERS()) ? readdir(READERS()) : [];
}

describe("registration", () => {
  it("writes nothing for a project without indexed stores", async () => {
    const store = await SegmentStore.open(diskSegmentStoreIo(root, "events"));
    expect([store.exists, existsSync(path.join(root, ".llmwiki"))]).toEqual([false, false]);
  });

  it("registers the first commit's snapshot before its manifest is published", async () => {
    const io = diskSegmentStoreIo(root, "events");
    let leasedAtPublication: string[] = [];
    const watched = { ...io, publishManifest: (bytes: Buffer, revalidate: () => Promise<void>) => io.publishManifest(bytes, async () => { leasedAtPublication = await leases(); await revalidate(); }) };
    await (await SegmentStore.open(watched)).commit({ rows: [{ k: "e0", v: 0 }] });
    expect(leasedAtPublication).toHaveLength(1);
  });

  it("publishes one complete lease, reused by later opens", async () => {
    await (await SegmentStore.open(diskSegmentStoreIo(root, "events"))).commit({ rows: [{ k: "e0", v: 0 }] });
    await SegmentStore.open(diskSegmentStoreIo(root, "catalog"));
    const [lease, ...more] = await leases();
    expect(more).toEqual([]);
    const record = JSON.parse(await readFile(path.join(READERS(), lease!), "utf8")) as { format: string; owner: { pid: number } };
    expect([record.format, record.owner.pid]).toEqual(["llmwiki-indexed-reader-lease", process.pid]);
    expect((await readerCensus(root)).live).toEqual([lease]);
  });

  it("leaves exactly one 0600 lease in a 0700 directory and no scratch leaf", async () => {
    await (await SegmentStore.open(diskSegmentStoreIo(root, "events"))).commit({ rows: [{ k: "e0", v: 0 }] });
    const names = await leases();
    expect(names).toEqual([expect.stringMatching(/^[0-9a-f]{8}-\d+-[0-9a-f]{8}\.lease$/)]);
    const modes = [(await stat(READERS())).mode & PERMISSION_BITS, (await stat(path.join(READERS(), names[0]!))).mode & PERMISSION_BITS];
    expect(modes).toEqual([0o700, 0o600]);
  });
});

describe("crash residue", () => {
  it("keeps a dead writer's random-suffix scratch leaf uncertain and in place", async () => {
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const tag = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 8);
    const scratch = `${tag}-${deadPid}-0000abcd.lease.0123456789abcdef.tmp`;
    await mkdir(READERS(), { recursive: true });
    await writeFile(path.join(READERS(), scratch), JSON.stringify({ format: "llmwiki-indexed-reader-lease", version: 1, host: tag, owner: { pid: deadPid } }));
    expect(await readerCensus(root)).toEqual({ live: [], stale: [], uncertain: [scratch] });
    expect(await leases()).toEqual([scratch]);
  });
});

describe("refusals", () => {
  it("refuses a read whose lease cannot be published", async () => {
    await mkdir(path.join(root, ".llmwiki", "indexed", "events"), { recursive: true });
    await writeFile(READERS(), "a file where the lease directory belongs");
    await expect(SegmentStore.open(diskSegmentStoreIo(root, "events"))).rejects.toThrow(/indexed_reader_lease_unavailable: this process could not register/);
  });

  it("refuses later reads once the root was recreated at the same path", async () => {
    await (await SegmentStore.open(diskSegmentStoreIo(root, "events"))).commit({ rows: [{ k: "e0", v: 0 }] });
    await rm(root, { recursive: true, force: true });
    await mkdir(path.join(root, ".llmwiki", "indexed", "events"), { recursive: true });
    await expect(SegmentStore.open(diskSegmentStoreIo(root, "events"))).rejects.toThrow(/reader lease .* was removed or replaced/);
  });

  it("refuses a retained snapshot's lazy segment read once its lease vanished", async () => {
    const snapshot = await (await SegmentStore.open(diskSegmentStoreIo(root, "events"))).commit({ rows: [{ k: "e0", v: 0 }] });
    for (const lease of await leases()) await rm(path.join(READERS(), lease));
    await expect(snapshot.get("e0")).rejects.toThrow(/reader lease .* was removed or replaced/);
  });
});

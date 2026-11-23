/**
 * @file test/history/integrity.test.ts
 * @description Fail-closed integrity of the segmented histories: manifests
 * with unknown or wrong-domain facts are corruption, a point index that
 * addresses another record is caught rather than trusted, and an appended
 * tail whose `prevHash` does not chain from its predecessor refuses the next
 * append. The corrupt states are planted through the store's own commit (so
 * digests are valid and only the semantics are wrong).
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { buildEventRecord } from "../../src/events/event-build.js";
import { eventPrevHash } from "../../src/events/event-digest.js";
import { appendEvent, appendEventLocked } from "../../src/events/store.js";
import { indexKey } from "../../src/history/contracts.js";
import { EVENT_PREFIX, eventLogMetaOf, openEventLog } from "../../src/history/events-log.js";
import { importHistories } from "../../src/history/history-import.js";
import { catalogRecordByMutation, openOperationCatalog } from "../../src/history/operation-catalog.js";
import { catalogSummary } from "../../src/history/operation-catalog-read.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import { appendCatalogRecordLocked, createCatalogRecord } from "../../src/operation-bundles/catalog-store.js";
import type { MutationId } from "../../src/operation-bundles/ids.js";
import { activateIndexed, recordIndexedTransition } from "../catalog/helpers.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-hist-int-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const INPUT = { type: "connector-fetch" as const, origin: "test", payload: {}, at: "2026-10-26T00:00:00.000Z" };
const mutation = (seed: string): MutationId => `opm_${createHash("sha256").update(seed).digest("hex")}`;

describe("history manifests", () => {
  it("refuse unknown keys and out-of-domain facts", async () => {
    await activateIndexed(root);
    await appendEvent(root, INPUT);
    const store = await openEventLog(root);
    const meta = eventLogMetaOf(store);
    for (const bad of [{ ...meta, extra: 1 }, { ...meta, headerVersion: 9 }, { ...meta, headDigest: "nothex" }, { ...meta, legacy: { ...meta.legacy, relPath: "elsewhere.jsonl" } }]) {
      const tampered = await (await openEventLog(root)).commit({ meta: bad as Record<string, unknown> });
      expect(() => eventLogMetaOf(tampered)).toThrow("manifest is missing or malformed");
    }
  });
});

describe("point indexes and the tail", () => {
  it("catch a mutation index that addresses another record", async () => {
    const make = (seed: string) => createCatalogRecord({ logicalRecordId: `l-${seed}`, mutationId: mutation(seed), payload: {}, createdAt: INPUT.at });
    await appendCatalogRecordLocked(root, "research", make("a"));
    await activateIndexed(root);
    await appendCatalogRecordLocked(root, "research", make("b"));
    const store = await openOperationCatalog(root, "research");
    const forged = await store.commit({ rows: [{ k: `m${mutation("b")}`, v: { index: 0 } }] });
    await expect(catalogRecordByMutation(forged, mutation("b"))).rejects.toThrow("points at another record");
  });

  it("refuses to append after a tail that does not chain from its predecessor", async () => {
    await activateIndexed(root);
    const first = await appendEventLocked(root, INPUT);
    const store = await openEventLog(root);
    const meta = eventLogMetaOf(store);
    const rogue = buildEventRecord(INPUT, "f".repeat(64));
    await store.commit({ rows: [{ k: indexKey(EVENT_PREFIX, meta.count), v: rogue }], meta: { ...meta, count: meta.count + 1, headDigest: eventPrevHash(rogue) } });
    expect(first.prevHash).toBe("genesis");
    await expect(appendEventLocked(root, INPUT)).rejects.toThrow("does not chain from its sealed predecessor");
  });
});

describe("import resume coherence", () => {
  it("adds only a longer file's tail on rerun and refuses a rewritten or shrunk history", async () => {
    const make = (seed: string) => createCatalogRecord({ logicalRecordId: `l-${seed}`, mutationId: mutation(seed), payload: { seed }, createdAt: INPUT.at });
    await appendCatalogRecordLocked(root, "research", make("a"));
    await appendCatalogRecordLocked(root, "research", make("b"));
    await recordIndexedTransition(root);
    expect(await importHistories(root)).toContain("2 catalog records");
    await appendCatalogRecordLocked(root, "research", make("c"));
    expect(await importHistories(root)).toContain("1 catalog records");
    const file = operationPaths(root, "research").catalogFile;
    const lines = (await readFile(file, "utf8")).split("\n");
    await writeFile(file, [JSON.stringify({ ...JSON.parse(lines[1]!), createdAt: "2026-10-27T00:00:00.000Z" }), lines[0], lines[2], ""].join("\n"));
    await expect(importHistories(root)).rejects.toThrow();
    await writeFile(file, `${lines[0]}\n`);
    await expect(importHistories(root)).rejects.toThrow("shorter than its imported history");
  });
});

describe("absence versus unavailable authority", () => {
  it("treats a link planted where an absent backup was as drift, not absence", async () => {
    await activateIndexed(root);
    await appendEventLocked(root, INPUT);
    await mkdir(path.join(root, "wiki", "graph"), { recursive: true });
    await writeFile(path.join(root, "elsewhere.jsonl"), "");
    await symlink(path.join(root, "elsewhere.jsonl"), path.join(root, "wiki", "graph", "events.jsonl"));
    await expect(appendEventLocked(root, INPUT)).rejects.toThrow("changed after it was imported");
  });

  it.each(["removed", "renamed"])("refuses a workspace catalog whose manifest alone was %s, instead of starting a new history", async (loss) => {
    const make = (seed: string) => createCatalogRecord({ logicalRecordId: `l-${seed}`, mutationId: mutation(seed), payload: {}, createdAt: INPUT.at });
    await activateIndexed(root);
    expect(await appendCatalogRecordLocked(root, "fresh", make("first"))).toBe("created");
    const dir = path.join(root, ".llmwiki", "indexed", (await openOperationCatalog(root, "fresh")).io.store);
    // Renamed leaves TWO leaves behind, more than the one-entry probe lists: still not "empty".
    if (loss === "removed") await rm(path.join(dir, "manifest.json"));
    else await rename(path.join(dir, "manifest.json"), path.join(dir, "manifest.json.lost"));
    expect(await catalogSummary(root, "fresh")).toMatchObject({ status: "invalid", detail: expect.stringContaining("manifest is missing") });
    await expect(appendCatalogRecordLocked(root, "fresh", make("second"))).rejects.toThrow("manifest is missing");
  });
});

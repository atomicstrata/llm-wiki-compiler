/**
 * @file test/scale/downgrade-export.test.ts
 * @description The scale-down EXPORTS of an active `local-indexed` project on
 * real disk. Each authority holds writes made AFTER activation (so the frozen
 * legacy backup is stale) and is exported into its incumbent file format:
 * events and relations carry the backup as an exact byte prefix and add the
 * newer records; a workspace catalog, the compile state and the vector store
 * export the CURRENT authority. Every export passes the incumbent strict
 * reader (`verify*Bytes`), and a counting sink measures exactly the bytes and
 * digest a writing sink produces. Tampered bytes fail verification.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, setDefaultTimeout, vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { appendEvent } from "../../src/events/store.js";
import { appendCatalogRecordLocked, createCatalogRecord } from "../../src/operation-bundles/catalog-store.js";
import type { MutationId } from "../../src/operation-bundles/ids.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import { appendRelation } from "../../src/relations/store.js";
import { exportEvents, exportRelations, exportWorkspaceCatalog, type SinkFactory } from "../../src/scale/downgrade-export-history.js";
import { ExportSink, type ExportedFile } from "../../src/scale/downgrade-sink.js";
import { verifyCatalogBytes, verifyEventsBytes, verifyRelationsBytes } from "../../src/scale/downgrade-verify.js";
import { EVENTS_FILE, RELATIONS_FILE } from "../../src/utils/constants.js";
import { activateIndexed } from "../catalog/helpers.js";
import { EXPERIMENT_A, experimentsIdeasProfile } from "../fixtures/profile-fixtures.js";

/**
 * Each case activates `local-indexed` in process (several durable commits):
 * measured 12-15 s alone, over the 30-second default with three parallel
 * workers on the shared private test volume, so the file gets this bound.
 */
setDefaultTimeout(300_000);

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-downgrade-export-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

const EVENT = { type: "connector-fetch" as const, origin: "test", payload: {}, at: "2026-10-30T00:00:00.000Z" };
const PROFILE = experimentsIdeasProfile({ tests: { from: ["experiments"], to: ["ideas"], direction: "directed" } });
const WS = "research";

/** A writing sink factory that keeps every exported file's bytes in memory. */
function memorySinks(): { sinkFor: SinkFactory; bytesOf: (relPath: string) => Buffer } {
  const files = new Map<string, Buffer[]>();
  /** A writing sink collecting `relPath`'s chunks. */
  const sinkFor: SinkFactory = (relPath, cap) => {
    files.set(relPath, []);
    return new ExportSink(relPath, cap, async (chunk) => { files.get(relPath)!.push(chunk); });
  };
  return { sinkFor, bytesOf: (relPath) => Buffer.concat(files.get(relPath) ?? []) };
}

/** A counting sink factory: measures only. */
const counting: SinkFactory = (relPath, cap) => new ExportSink(relPath, cap);

/** The relation input to idea `n`. */
const toIdea = (n: number) => ({ type: "tests", from: EXPERIMENT_A, to: `ideas/n${n}` as never, attributes: {} });
/** One deterministic mutation identity for `seed`. */
const mutation = (seed: string) => `opm_${createHash("sha256").update(seed).digest("hex")}` as MutationId;
/** One canonical catalog record for `seed`. */
const catalogRecord = (seed: string) => createCatalogRecord({ logicalRecordId: `logical-${seed}`, mutationId: mutation(seed), payload: { seed }, createdAt: "2026-10-30T00:00:00.000Z" });

/** The SHA-256 of `bytes`. */
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Expect a measured export to be byte-for-byte the written one. */
function expectMeasuredEqualsWritten(measured: ExportedFile, written: ExportedFile, bytes: Buffer): void {
  expect(measured).toEqual(written);
  expect([written.bytes, written.sha256]).toEqual([bytes.byteLength, sha(bytes)]);
}

describe("history exports carry the current authority", () => {
  it("exports events written after activation, with the frozen backup as an exact prefix", async () => {
    for (let n = 0; n < 2; n += 1) await appendEvent(root, EVENT);
    await activateIndexed(root);
    const backup = await readFile(path.join(root, EVENTS_FILE));
    for (let n = 0; n < 3; n += 1) await appendEvent(root, { ...EVENT, origin: `after-${n}` });
    const sinks = memorySinks();
    const written = await exportEvents(root, sinks.sinkFor);
    const bytes = sinks.bytesOf(EVENTS_FILE);
    expect([written.present, written.records]).toEqual([true, 5]);
    expect(bytes.subarray(0, backup.byteLength)).toEqual(backup);
    await verifyEventsBytes(root, bytes, written);
    expectMeasuredEqualsWritten(await exportEvents(root, counting), written, bytes);
    await expect(verifyEventsBytes(root, bytes.subarray(0, bytes.byteLength - 10), written)).rejects.toMatchObject({ code: "downgrade_export_mismatch" });
  });

  it("exports relations written after activation, with the frozen backup as an exact prefix", async () => {
    for (let n = 0; n < 3; n += 1) await appendRelation(root, PROFILE, toIdea(n));
    await activateIndexed(root);
    const backup = await readFile(path.join(root, RELATIONS_FILE));
    await appendRelation(root, PROFILE, toIdea(99));
    const sinks = memorySinks();
    const written = await exportRelations(root, sinks.sinkFor);
    const bytes = sinks.bytesOf(RELATIONS_FILE);
    expect(written.records).toBe(4);
    expect(bytes.subarray(0, backup.byteLength)).toEqual(backup);
    await verifyRelationsBytes(bytes, written);
    expectMeasuredEqualsWritten(await exportRelations(root, counting), written, bytes);
  });

});

describe("catalog and empty exports carry the current authority", () => {
  it("exports a workspace catalog appended after activation", async () => {
    for (const seed of ["a", "b"]) await appendCatalogRecordLocked(root, WS, catalogRecord(seed));
    await activateIndexed(root);
    const backup = await readFile(operationPaths(root, WS).catalogFile);
    await appendCatalogRecordLocked(root, WS, catalogRecord("c"));
    const sinks = memorySinks();
    const written = await exportWorkspaceCatalog(root, WS, sinks.sinkFor);
    const bytes = sinks.bytesOf(written.relPath);
    expect(written.records).toBe(3);
    expect(bytes.subarray(0, backup.byteLength)).toEqual(backup);
    verifyCatalogBytes(bytes, written);
    expectMeasuredEqualsWritten(await exportWorkspaceCatalog(root, WS, counting), written, bytes);
  });

  it("exports no file for logs and catalogs that are empty and never had one", async () => {
    await activateIndexed(root);
    const sinks = memorySinks();
    expect((await exportEvents(root, sinks.sinkFor)).present).toBe(false);
    expect((await exportRelations(root, sinks.sinkFor)).present).toBe(false);
  });
});

describe("sinks", () => {
  it("a writing sink refuses the first byte past the cap; a counting sink keeps measuring", async () => {
    const writing = new ExportSink("x", 4, async () => {});
    await expect(writing.push("12345")).rejects.toMatchObject({ code: "downgrade_export_too_large" });
    const measuring = new ExportSink("x", 4);
    await measuring.push("12345");
    expect((await measuring.finish(1)).bytes).toBe(5);
  });
});

/**
 * @file test/scale-measure/lookup-semantics.test.ts
 * @description Missing seeded lookup results must fail measurement children.
 */

import { afterEach, expect, it, vi } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as catalogMeta from "../../src/catalog/meta.js";
import * as catalogReads from "../../src/catalog/reads.js";
import * as eventReads from "../../src/history/events-read.js";
import * as operationCatalog from "../../src/history/operation-catalog.js";
import * as catalogStore from "../../src/operation-bundles/catalog-store.js";
import * as sourceSelection from "../../src/sources/selection.js";
import * as corpus from "./corpus.js";
import { MEASURED_OPS } from "./ops.js";

const shape = { docs: 2, chunksPerDoc: 1, eventsPerDoc: 1, relationsPerDoc: 1, expectedDocuments: 10_000 };

afterEach(() => vi.restoreAllMocks());

/** Stub the catalog write and return one controlled mutation lookup result. */
function stubOperationLookup(result: Awaited<ReturnType<typeof operationCatalog.catalogRecordByMutation>>): void {
  vi.spyOn(corpus, "underProjectLock").mockImplementation(async (_root, write) => write());
  vi.spyOn(catalogStore, "appendCatalogRecordLocked").mockResolvedValue({} as never);
  vi.spyOn(operationCatalog, "openOperationCatalog").mockResolvedValue({} as never);
  vi.spyOn(operationCatalog, "catalogRecordByMutation").mockResolvedValue(result);
}

it("refuses a missing seeded source identity", async () => {
  vi.spyOn(catalogMeta, "openCatalog").mockResolvedValue({} as never);
  vi.spyOn(sourceSelection, "loadSourceSelection").mockResolvedValue({} as never);
  vi.spyOn(catalogReads, "lookupSourceIdentity").mockResolvedValue(null);
  await expect(MEASURED_OPS["identity-lookup"]!.run("/unused", shape, 0)).rejects.toThrow("source identity lookup returned no seeded source");
});

it("accepts the seeded source identity", async () => {
  vi.spyOn(catalogMeta, "openCatalog").mockResolvedValue({} as never);
  vi.spyOn(sourceSelection, "loadSourceSelection").mockResolvedValue({} as never);
  vi.spyOn(catalogReads, "lookupSourceIdentity").mockResolvedValue("source-1.md");
  expect(await MEASURED_OPS["identity-lookup"]!.run("/unused", shape, 0)).toEqual({ found: "source-1.md" });
});

it("refuses an empty bound event lookup", async () => {
  vi.spyOn(eventReads, "findEventsByMutation").mockResolvedValue([]);
  await expect(MEASURED_OPS["event-find-mutation"]!.run("/unused", shape, 0)).rejects.toThrow("bound event lookup returned no seeded event");
});

it("accepts one seeded bound event", async () => {
  vi.spyOn(eventReads, "findEventsByMutation").mockResolvedValue([{}] as never);
  expect(await MEASURED_OPS["event-find-mutation"]!.run("/unused", shape, 0)).toEqual({ found: 1 });
});

it("refuses a missing seeded operation catalog mutation", async () => {
  stubOperationLookup(undefined);
  await expect(MEASURED_OPS["opcat-append-lookup"]!.run("/unused", shape, 0)).rejects.toThrow("operation catalog lookup returned no seeded record");
});

it("accepts the seeded operation catalog record", async () => {
  stubOperationLookup(corpus.opcatRecord(1) as never);
  expect(await MEASURED_OPS["opcat-append-lookup"]!.run("/unused", shape, 0)).toMatchObject({ found: true });
});

it("keeps the zero-document calibration operation available", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-measure-calibration-"));
  try {
    const result = await MEASURED_OPS["fs-calibration"]!.run(root, { ...shape, docs: 0 }, 0);
    expect(result).toMatchObject({ expected: { opens: 2, bytesWritten: 96, bytesRead: 160 } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

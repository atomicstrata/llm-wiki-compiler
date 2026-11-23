/**
 * @file test/scale-measure/list-semantics.test.ts
 * @description Timed measurement reads must prove the seeded corpus is visible.
 */

import { afterEach, expect, it, vi } from "bun:test";
import * as core from "../../src/sdk/core.js";
import { MEASURED_OPS } from "./ops.js";

const shape = { docs: 2, chunksPerDoc: 1, eventsPerDoc: 1, relationsPerDoc: 1, expectedDocuments: 10_000 };
afterEach(() => vi.restoreAllMocks());

/** Replace the SDK entry with controlled read answers for this child operation. */
function sdk(reads: Record<string, unknown>): void {
  vi.spyOn(core, "createWikiCore").mockReturnValue(reads as never);
}

it("refuses an empty page listing after seeding two pages", async () => {
  sdk({ listPages: async () => ({ pages: [] }) });
  await expect(MEASURED_OPS["list-pages"]!.run("/unused", shape, 0)).rejects.toThrow("page listing did not return seeded pages");
});

it("refuses an empty source listing after seeding two sources", async () => {
  sdk({ listSources: async () => ({ sources: [] }) });
  await expect(MEASURED_OPS["list-sources"]!.run("/unused", shape, 0)).rejects.toThrow("source listing did not return seeded sources");
});

it("refuses a status with no seeded sources or pages", async () => {
  sdk({ status: async () => ({ pages: { total: 0 }, sources: 0 }) });
  await expect(MEASURED_OPS["status"]!.run("/unused", shape, 0)).rejects.toThrow("status did not include seeded corpus");
});

it("accepts the seeded page, source and status answers", async () => {
  sdk({
    listPages: async () => ({ pages: [{}, {}] }),
    listSources: async () => ({ sources: [{}, {}] }),
    status: async () => ({ pages: { total: 2 }, sources: 3 }),
  });
  expect(await MEASURED_OPS["list-pages"]!.run("/unused", shape, 0)).toMatchObject({ first: 2 });
  expect(await MEASURED_OPS["list-sources"]!.run("/unused", shape, 0)).toMatchObject({ sources: 2 });
  expect(await MEASURED_OPS["status"]!.run("/unused", shape, 0)).toMatchObject({ sources: 3, pages: 2 });
});

/**
 * @file test/scale-measure/witness-gaps.test.ts
 * @description Measurement witnesses must refuse results that did not do the
 * measured work: a 100-document page listing needs a cursor and a full second
 * page, and a standard migration is complete only when `scale.set` reports a
 * `ready` project whose active architecture is `local-indexed` with nothing
 * pending (`unavailable`, `preparing` and `parked` are not completed work).
 * An `init` that requested an indexed layout must likewise report `local-indexed`, ready, nothing pending: a parked
 * preparation (for example the free-space preflight) is refused with its parked step, not silently accepted.
 */

import { afterEach, expect, it, vi } from "bun:test";
import * as core from "../../src/sdk/core.js";
import { BUILD_PHASES } from "./corpus.js";
import { MEASURED_OPS } from "./ops.js";

const shape = { docs: 100, chunksPerDoc: 1, eventsPerDoc: 1, relationsPerDoc: 1, expectedDocuments: 0 };
const pages = (count: number) => Array.from({ length: count }, () => ({}));
afterEach(() => vi.restoreAllMocks());

/** Replace the SDK entry with a controlled facade. */
function sdk(facade: Record<string, unknown>): void {
  vi.spyOn(core, "createWikiCore").mockReturnValue(facade as never);
}

/** A `scale.set` answer shaped like the production report. */
function setReport(readiness: string, architecture: string, pending: unknown = null): void {
  sdk({ scale: { set: async () => ({ readiness, record: { active: { architecture }, pending } }) } });
}

it("refuses a first page with no cursor when 100 pages are seeded", async () => {
  sdk({ listPages: async () => ({ pages: pages(50) }) });
  await expect(MEASURED_OPS["list-pages"]!.run("/unused", shape, 0)).rejects.toThrow("page listing did not return a cursor");
});

it("refuses a cursor whose second page is empty or short", async () => {
  sdk({ listPages: async (o: { cursor?: string }) => (o.cursor === undefined ? { pages: pages(50), cursor: "c" } : { pages: pages(49) }) });
  await expect(MEASURED_OPS["list-pages"]!.run("/unused", shape, 0)).rejects.toThrow("page listing second page was short");
});

it("accepts two full pages of a 100-page corpus", async () => {
  sdk({ listPages: async (o: { cursor?: string }) => (o.cursor === undefined ? { pages: pages(50), cursor: "c" } : { pages: pages(50) }) });
  expect(await MEASURED_OPS["list-pages"]!.run("/unused", shape, 0)).toMatchObject({ first: 50, next: 50 });
});

it("refuses an unavailable migration that recorded a pending estimate", async () => {
  setReport("unavailable", "local-standard", { kind: "unavailable" });
  await expect(BUILD_PHASES["migrate"]!("/unused", shape)).rejects.toThrow("migration did not complete");
});

it("refuses a preparing migration even with the indexed architecture active", async () => {
  setReport("preparing", "local-indexed");
  await expect(BUILD_PHASES["migrate"]!("/unused", shape)).rejects.toThrow("migration did not complete");
});

it("refuses a ready report that is still on the standard architecture", async () => {
  setReport("ready", "local-standard");
  await expect(BUILD_PHASES["migrate"]!("/unused", shape)).rejects.toThrow("migration did not complete");
});

it("accepts a ready indexed migration with nothing pending", async () => {
  setReport("ready", "local-indexed");
  expect(await BUILD_PHASES["migrate"]!("/unused", shape)).toMatchObject({ readiness: "ready", active: "local-indexed", pending: null });
});

const indexedShape = { ...shape, expectedDocuments: 10_000 };

/** Replace `initWikiCore` with a facade whose `scale.status` answers `report`; returns the status spy. */
function initReport(report: unknown) {
  const status = vi.fn(async () => report);
  vi.spyOn(core, "initWikiCore").mockResolvedValue({ scale: { status } } as never);
  return status;
}

const parkedPreflight = { kind: "prepare", target: "local-indexed", steps: [{ name: "capacity-preflight", status: "parked", detail: "insufficient-disk: free 7098449920 B, conservative estimate 8282701824 B" }] };

it("refuses an indexed init whose preparation parked, naming the parked step", async () => {
  initReport({ readiness: "parked", record: { active: { architecture: "local-standard" }, pending: parkedPreflight } });
  await expect(BUILD_PHASES["init"]!("/unused", indexedShape)).rejects.toThrow(/did not reach local-indexed for 10000 expected documents.*capacity-preflight: insufficient-disk/);
});

it("refuses an indexed init that is ready but still on the standard architecture", async () => {
  initReport({ readiness: "ready", record: { active: { architecture: "local-standard" }, pending: null } });
  await expect(BUILD_PHASES["init"]!("/unused", indexedShape)).rejects.toThrow("active local-standard");
});

it("bounds the parked step's detail in the refusal", async () => {
  initReport({ readiness: "parked", record: { active: { architecture: "local-standard" }, pending: { steps: [{ name: "capacity-preflight", status: "parked", detail: "x".repeat(5000) }] } } });
  const refusal = await BUILD_PHASES["init"]!("/unused", indexedShape).then(() => "", (error: Error) => error.message);
  expect(refusal.length).toBeLessThan(800);
});

it("accepts a ready indexed init with nothing pending", async () => {
  initReport({ readiness: "ready", record: { active: { architecture: "local-indexed" }, pending: null } });
  expect(await BUILD_PHASES["init"]!("/unused", indexedShape)).toEqual({ expectedDocuments: 10_000, architecture: "local-indexed" });
});

it("keeps the default (standard) init valid without asking for a scale report", async () => {
  const status = initReport({ readiness: "parked", record: null });
  expect(await BUILD_PHASES["init"]!("/unused", shape)).toEqual({ expectedDocuments: 0 });
  expect(status).not.toHaveBeenCalled();
});

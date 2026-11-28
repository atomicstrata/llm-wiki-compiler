/**
 * @file test/history/refusal-codes.test.ts
 * @description The stable `code` contracts of the indexed refusals a caller
 * branches on: an explicit catalog reconciliation on a project that is not
 * `local-indexed` refuses with `catalog_not_active` (nothing created), and a
 * whole-history compatibility read at its cap refuses with
 * `history_materialization_too_large`. The latter uses one real indexed
 * event and a test-only byte-count seam instead of a 64 MiB fixture.
 */

import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { CatalogNotActiveError } from "../../src/catalog/facade.js";
import { HistoryMaterializationTooLargeError } from "../../src/history/contracts.js";
import { readAllEvents } from "../../src/history/events-read.js";
import { appendSegmentedEvent } from "../../src/history/events-log.js";
import { createWikiCore } from "../../src/sdk/core.js";
import { MAX_EVENT_STORE_BYTES } from "../../src/utils/constants.js";
import { activateIndexed, writeCorpus } from "../catalog/helpers.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-refusal-codes-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("indexed refusal codes", () => {
  it("refuses a catalog reconciliation on a project that is not indexed with catalog_not_active", async () => {
    const refusal = await createWikiCore({ root }).catalog.sync().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CatalogNotActiveError);
    expect((refusal as CatalogNotActiveError).code).toBe("catalog_not_active");
    await expect(lstat(path.join(root, ".llmwiki", "indexed"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a whole-history read when its measured bytes reach the cap", async () => {
    expect(new HistoryMaterializationTooLargeError("event", MAX_EVENT_STORE_BYTES).code)
      .toBe("history_materialization_too_large");
    await writeCorpus(root, 0, 0);
    await activateIndexed(root);
    const event = await appendSegmentedEvent(root, {
      type: "lifecycle-transition", origin: "test", payload: { state: "ready" }, at: "2026-01-01T00:00:00.000Z",
    });
    expect((await readAllEvents(root)).events).toHaveLength(1);
    const serialized = JSON.stringify(event);
    const actualByteLength = Buffer.byteLength;
    let measured = false;
    const measureAtCap = vi.spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => {
      if (value === serialized) { measured = true; return MAX_EVENT_STORE_BYTES - 1; }
      return actualByteLength(value, encoding);
    });
    try {
      await expect(readAllEvents(root)).rejects.toMatchObject({
        code: "history_materialization_too_large",
        message: expect.stringContaining(`${MAX_EVENT_STORE_BYTES}-byte compatibility read cap`),
      });
      expect(measured).toBe(true);
    } finally {
      measureAtCap.mockRestore();
    }
  });
});

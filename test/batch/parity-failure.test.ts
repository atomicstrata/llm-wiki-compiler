/**
 * @file test/batch/parity-failure.test.ts
 * @description An extraction that yields no concepts is a FAILURE in both
 * compile bodies (the public contract): the source keeps its old concepts
 * with a blank hash so the next run retries it, its pages are frozen (not
 * regenerated, not orphaned), and the batch compile leaves exactly what the
 * classic compile leaves. A small two-source project, so the case fits a
 * bounded test group on slow storage; the larger failure-and-retry journey is
 * in `./parity-changes.test.ts`.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "bun:test";
import { sourceNaming } from "./helpers.js";
import { PARITY_TIMEOUT_MS, useParityTwin } from "./parity-fixture.js";

const twin = useParityTwin();

/** Two sources sharing one concept, so a failed owner leaves a page another source still owns. */
const SMALL = {
  "one.md": sourceNaming("One", "Shared Idea", "One Only"),
  "two.md": sourceNaming("Two", "Shared Idea"),
};

describe("batch compile parity: a failed extraction", () => {
  it("retains the failed source's concepts and frozen pages exactly as the classic compile does", async () => {
    await twin.start(SMALL);
    await twin.compileBoth(2);
    await twin.onBoth((root) => writeFile(path.join(root, "sources", "one.md"), sourceNaming("One", "!fail")));
    await twin.compileBoth(2);
  }, PARITY_TIMEOUT_MS);
});

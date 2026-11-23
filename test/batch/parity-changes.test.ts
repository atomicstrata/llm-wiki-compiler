/**
 * @file test/batch/parity-changes.test.ts
 * @description The batch compile leaves exactly what the classic compile
 * leaves across CHANGES: an edit plus a deletion whose concept a surviving
 * source still owns, and an extraction failure (a freeze) retried after it
 * is fixed. Each case runs several compiles of both twins, so on slow storage
 * this file needs many minutes and is run in the full suite.
 */

import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "bun:test";
import { sourceNaming } from "./helpers.js";
import { PARITY_TIMEOUT_MS, SOURCES, useParityTwin } from "./parity-fixture.js";

const twin = useParityTwin();

describe("batch compile parity: changes", () => {
  it("matches an edit plus a deletion whose concept a survivor still owns", async () => {
    await twin.start(SOURCES);
    await twin.compileBoth(2);
    await twin.onBoth((root) => writeFile(path.join(root, "sources", "beta.md"), sourceNaming("Beta", "Beta Only", "Shared Idea")));
    await twin.onBoth((root) => unlink(path.join(root, "sources", "gamma.md")));
    await twin.compileBoth(1);
  }, PARITY_TIMEOUT_MS);

  it("matches an extraction failure (a freeze) and its retry", async () => {
    await twin.start(SOURCES);
    await twin.compileBoth(3);
    await twin.onBoth((root) => writeFile(path.join(root, "sources", "alpha.md"), sourceNaming("Alpha", "!fail")));
    await twin.compileBoth(2);
    await twin.onBoth((root) => writeFile(path.join(root, "sources", "alpha.md"), sourceNaming("Alpha", "Shared Idea")));
    await twin.compileBoth(2);
  }, PARITY_TIMEOUT_MS);
});

/**
 * @file test/batch/parity-fresh.test.ts
 * @description The batch compile GENERATES pages and leaves exactly what the
 * classic compile leaves (pages, index, MOC, compile state in insertion
 * order), on twin projects driven by the same test-only deterministic
 * provider: a fresh compile whose concepts are shared across checkpointed
 * batches of two.
 */

import { describe, it } from "bun:test";
import { PARITY_TIMEOUT_MS, SOURCES, useParityTwin } from "./parity-fixture.js";

const twin = useParityTwin();

describe("batch compile parity: a fresh compile", () => {
  it("matches the classic compile with concepts shared across batches", async () => {
    await twin.start(SOURCES);
    await twin.compileBoth(2);
  }, PARITY_TIMEOUT_MS);
});

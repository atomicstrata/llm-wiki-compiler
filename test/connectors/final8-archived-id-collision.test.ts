/**
 * @file test/connectors/final8-archived-id-collision.test.ts
 * @description Decision 18 integration regression proves a connector does not
 * reuse the identity of the predecessor it just archived.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfinedFetchResult } from "../../src/connectors/confined-fetch.js";
import { runConnector } from "../../src/connectors/run.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { plantConnectorCandidate } from "./final6-fixtures.js";
import { activateFixtureConnector } from "./run-test-fixtures.js";

const suffixes = vi.hoisted((): Buffer[] => []);

vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("crypto")>();
  return {
    ...actual,
    randomBytes: (size: number) => size === 4 && suffixes.length > 0
      ? Buffer.from(suffixes.shift()!)
      : actual.randomBytes(size),
  };
});

const root = useTempRoot();
const OLD_ID = "fixture-story-1-11111111";
const NEW_ID = "fixture-story-1-22222222";

/** Return a changed response so the selected candidate is superseded. */
function fixtureFetch(): Promise<ConfinedFetchResult> {
  return Promise.resolve({
    kind: "ok", finalUrl: "https://fixture.local/story-1",
    bytes: Buffer.from("{}"), contentHash: "d".repeat(64),
  });
}

/** Activate, plant, and replace the deterministic selected predecessor. */
async function replaceSelectedPredecessor() {
  await activateFixtureConnector(root.dir);
  await plantConnectorCandidate(root.dir, OLD_ID);
  const result = await runConnector(root.dir, "fixture", { id: "story-1" }, {
    fetcher: fixtureFetch,
  });
  return {
    candidates: path.join(root.dir, ".llmwiki", "candidates"),
    result,
  };
}

describe("Final8 connector archived-id collision", () => {
  beforeEach(() => {
    suffixes.splice(0, suffixes.length,
      Buffer.from("11111111", "hex"), Buffer.from("22222222", "hex"));
  });
  afterEach(() => { delete process.env.LLMWIKI_CONNECTORS; });

  it("retries past the connector predecessor's archived identity", async () => {
    const { candidates, result } = await replaceSelectedPredecessor();

    expect(result).toEqual({
      kind: "superseded", archivedIds: [OLD_ID], candidateIds: [NEW_ID],
    });
    expect(existsSync(path.join(candidates, `${NEW_ID}.json`))).toBe(true);
    expect(existsSync(path.join(candidates, `${OLD_ID}.json`))).toBe(false);
    expect(existsSync(path.join(candidates, "archive", `${OLD_ID}.json`))).toBe(true);
  });

  it("restores the predecessor after sixteen archived-id collisions", async () => {
    suffixes.splice(0, suffixes.length,
      ...Array.from({ length: 16 }, () => Buffer.from("11111111", "hex")));
    const { candidates, result } = await replaceSelectedPredecessor();

    expect(result).toEqual({ kind: "unavailable", reason: "connector candidate store unavailable" });
    expect(existsSync(path.join(candidates, `${OLD_ID}.json`))).toBe(true);
    expect(existsSync(path.join(candidates, "archive", `${OLD_ID}.json`))).toBe(false);
  });
});

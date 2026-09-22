/**
 * @file test/connectors/final7-split-lock-overflow.test.ts
 * @description Decision 15 regression records the honest legacy split-lock
 * behavior when candidate 201 arrives only after the pre-fetch snapshot.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfinedFetchResult } from "../../src/connectors/confined-fetch.js";
import { runConnector } from "../../src/connectors/run.js";
import { readEvents } from "../../src/events/store-read.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { plantConnectorCandidate, plantConnectorCandidateBatch } from "./final6-fixtures.js";
import { activateFixtureConnector } from "./run-test-fixtures.js";

const root = useTempRoot();
const NOW = () => new Date("2026-07-17T00:00:00.000Z");

/** Turn on a visible positive request interval. */
async function enableRateState(): Promise<void> {
  const file = path.join(root.dir, ".llmwiki", "config.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  const fixture = { ...config.connectors.fixture, minRequestIntervalMs: 1_000 };
  const updated = { ...config, connectors: { ...config.connectors, fixture } };
  await writeFile(file, JSON.stringify(updated));
}

describe("Final7 split-lock candidate overflow", () => {
  afterEach(() => { delete process.env.LLMWIKI_CONNECTORS; });

  it("includes a late 201st entry in the public no-op result and audit", async () => {
    await activateFixtureConnector(root.dir);
    await enableRateState();
    const ids = await plantConnectorCandidateBatch(root.dir, 200);
    let fetches = 0;
    const fetcher = async (): Promise<ConfinedFetchResult> => {
      fetches += 1;
      await plantConnectorCandidate(root.dir, "bound-200");
      return {
        kind: "ok", finalUrl: "https://fixture.local/story-1",
        bytes: Buffer.from("{}"), contentHash: "a".repeat(64),
      };
    };

    const result = await runConnector(root.dir, "fixture", { id: "story-1" }, { fetcher, now: NOW });

    expect(result).toEqual({ kind: "noop", candidateIds: [...ids, "bound-200"] });
    expect(fetches).toBe(1);
    expect(existsSync(path.join(root.dir, ".llmwiki", "connectors", "fixture.last-fetch.json"))).toBe(true);
    expect((await readEvents(root.dir)).events).toHaveLength(1);
  });
});

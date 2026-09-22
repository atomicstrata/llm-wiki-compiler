/**
 * @file test/connectors/final6-bounds.test.ts
 * @description Final6 connector regressions bind one canonical identity and
 * preserve public no-op behavior beyond the new direct-adapter batch ceiling.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfinedFetchResult } from "../../src/connectors/confined-fetch.js";
import { captureConnectorIdentity } from "../../src/connectors/candidate-identity.js";
import { runConnector } from "../../src/connectors/run.js";
import { readEvents } from "../../src/events/store-read.js";
import { snapshotCandidateQueue } from "../fixtures/candidate-queue.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import {
  FIXTURE_CONTENT_HASH,
  plantConnectorCandidateBatch,
} from "./final6-fixtures.js";
import { activateFixtureConnector } from "./run-test-fixtures.js";

const root = useTempRoot();
const NOW = () => new Date("2026-07-17T00:00:00.000Z");

/** Return one deterministic successful fetch and increment `counter`. */
function countedFetch(counter: { value: number }): () => Promise<ConfinedFetchResult> {
  return async () => {
    counter.value += 1;
    return {
      kind: "ok",
      finalUrl: "https://fixture.local/story-1",
      bytes: Buffer.from("{}"),
      contentHash: FIXTURE_CONTENT_HASH,
    };
  };
}

/** Enable a positive rate interval so invalid input would leave a visible stamp. */
async function enableRateLimit(): Promise<void> {
  const file = path.join(root.dir, ".llmwiki", "config.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  config.connectors.fixture.minRequestIntervalMs = 1_000;
  await writeFile(file, JSON.stringify(config));
}

/** The durable rate-state leaf for the fixture connector. */
function rateStamp(): string {
  return path.join(root.dir, ".llmwiki", "connectors", "fixture.last-fetch.json");
}

/** Run the bounded fixture with a visible fetch counter. */
function runBoundedFixture(fetches: { value: number }) {
  return runConnector(root.dir, "fixture", { id: "story-1" }, {
    fetcher: countedFetch(fetches),
    now: NOW,
  });
}

describe("Final6 connector identity and selection bounds", () => {
  afterEach(() => {
    delete process.env.LLMWIKI_CONNECTORS;
    vi.restoreAllMocks();
  });

  it("captures the canonical source identity exactly once", async () => {
    let calls = 0;
    const canonical = vi.fn(() => (++calls === 1 ? "story-1" : "changed-on-second-call"));

    const identity = captureConnectorIdentity({
      id: "fixture", version: "1", canonicalSourceId: canonical,
    }, {
      id: "story-1",
    });

    expect(canonical).toHaveBeenCalledTimes(1);
    expect(identity?.slug).toBe("fixture-story-1");
  });

  it("refuses an over-limit host slug before store, rate, fetch, or event work", async () => {
    await activateFixtureConnector(root.dir);
    await enableRateLimit();
    const fetches = { value: 0 };
    const candidateDir = path.join(root.dir, ".llmwiki", "candidates");

    const result = await runConnector(root.dir, "fixture", { id: "a".repeat(213) }, {
      fetcher: countedFetch(fetches),
      now: NOW,
    });

    expect(result).toEqual({ kind: "refused", reason: "connector candidate identity is invalid" });
    expect(fetches.value).toBe(0);
    expect(existsSync(rateStamp())).toBe(false);
    expect(existsSync(candidateDir)).toBe(false);
    expect((await readEvents(root.dir)).events).toEqual([]);
  });

  it("accepts exactly 200 selected candidates", async () => {
    await activateFixtureConnector(root.dir);
    const ids = await plantConnectorCandidateBatch(root.dir, 200);
    await expectCandidateNoop(ids);
  });

  it("keeps a 201-candidate no-op byte-identical while retaining its normal audit", async () => {
    await activateFixtureConnector(root.dir);
    await enableRateLimit();
    const ids = await plantConnectorCandidateBatch(root.dir, 201);
    const before = await snapshotCandidateQueue(root.dir);
    await expectCandidateNoop(ids);
    expect(existsSync(rateStamp())).toBe(true);
    expect((await readEvents(root.dir)).events).toHaveLength(1);
    expect(await snapshotCandidateQueue(root.dir)).toEqual(before);
  });
});

/** A retained-candidate no-op still performs exactly one connector fetch. */
async function expectCandidateNoop(ids: string[]): Promise<void> {
  const fetches = { value: 0 };
  const result = await runBoundedFixture(fetches);
  expect(result).toEqual({ kind: "noop", candidateIds: ids });
  expect(fetches.value).toBe(1);
}

/**
 * @file test/connectors/final8-queue-authority.test.ts
 * @description Decision 17 regressions bind fresh-intent capacity and selected
 * identity failures to the connector's closed normal-run result vocabulary.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CandidateIdentityMismatchError } from "../../src/compiler/candidates.js";
import { countCandidates } from "../../src/compiler/candidate-read.js";
import {
  selectConnectorCandidateEntries,
} from "../../src/connectors/candidate-supersession.js";
import type { ConfinedFetchResult } from "../../src/connectors/confined-fetch.js";
import { runConnector } from "../../src/connectors/run.js";
import { readEvents } from "../../src/events/store-read.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import {
  FIXTURE_IDEMPOTENCY_KEY,
  plantConnectorCandidate,
} from "./final6-fixtures.js";
import { activateFixtureConnector } from "./run-test-fixtures.js";

const root = useTempRoot();
const UNRELATED_KEY = "b".repeat(64);
const STORE_UNAVAILABLE = Object.freeze({
  kind: "unavailable" as const,
  reason: "connector candidate store unavailable",
});

/** Deterministic response with content distinct from planted selected records. */
function fixtureFetch(): Promise<ConfinedFetchResult> {
  return Promise.resolve({
    kind: "ok", finalUrl: "https://fixture.local/story-1",
    bytes: Buffer.from("{}"), contentHash: "d".repeat(64),
  });
}

/** Plant `count` candidates that are unrelated to the fixture connector key. */
async function plantUnrelated(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await plantConnectorCandidate(root.dir, `unrelated-${index}`, { idempotencyKey: UNRELATED_KEY });
  }
}

/** Activate the fixture and fill the queue with unrelated review objects. */
async function prepareUnrelatedQueue(count: number): Promise<void> {
  await activateFixtureConnector(root.dir);
  await plantUnrelated(count);
}

/** Run the fixture connector with safe defaults and optional test seams. */
function runFixture(deps: Parameters<typeof runConnector>[3] = {}) {
  return runConnector(root.dir, "fixture", { id: "story-1" }, {
    fetcher: fixtureFetch,
    ...deps,
  });
}

/** Run through a counted fetch while preserving every other supplied seam. */
function runCounted(fetches: { value: number }) {
  return runFixture({
    fetcher: async () => { fetches.value += 1; return fixtureFetch(); },
  });
}

/** Add the late unrelated candidate that defeats the staged-write backstop. */
async function runLateOverflow(blockRestore = false) {
  return runFixture({
    beforeCandidateStageForTest: async () => {
      await plantConnectorCandidate(root.dir, "late", { idempotencyKey: UNRELATED_KEY });
      if (blockRestore) {
        await plantConnectorCandidate(root.dir, "selected", { idempotencyKey: UNRELATED_KEY });
      }
    },
  });
}

/** Assert the fixed unavailable DTO and absence of an audit side effect. */
async function expectUnavailableWithoutEvent(result: Awaited<ReturnType<typeof runConnector>>) {
  expect(result).toEqual(STORE_UNAVAILABLE);
  expect((await readEvents(root.dir)).events).toEqual([]);
}

/** Rewrite one planted record so its embedded id contradicts the filename. */
async function mismatch(fileId: string): Promise<string> {
  const file = path.join(root.dir, ".llmwiki", "candidates", `${fileId}.json`);
  const record = JSON.parse(await readFile(file, "utf8"));
  record.id = `${fileId}-different`;
  const bytes = JSON.stringify(record);
  await writeFile(file, bytes);
  return bytes;
}

describe("Final8 connector queue authority", () => {
  afterEach(() => { delete process.env.LLMWIKI_CONNECTORS; });

  it("admits 199 unrelated candidates plus one fresh intent", async () => {
    await prepareUnrelatedQueue(199);

    const result = await runFixture();

    expect(result.kind).toBe("staged");
    expect(await countCandidates(root.dir)).toBe(200);
  });

  it("preserves the staged-write budget after fetching", async () => {
    await prepareUnrelatedQueue(200);
    const fetches = { value: 0 };

    const result = await runCounted(fetches);

    await expectUnavailableWithoutEvent(result);
    expect(fetches.value).toBe(1);
  });

  it("admits a full queue when one selected predecessor makes room", async () => {
    await prepareUnrelatedQueue(199);
    await plantConnectorCandidate(root.dir, "selected");

    const result = await runFixture();

    expect(result.kind).toBe("superseded");
    expect(await countCandidates(root.dir)).toBe(200);
  });

  it("permits a no-op in an already over-budget legacy queue", async () => {
    await prepareUnrelatedQueue(200);
    await plantConnectorCandidate(root.dir, "selected", { contentHash: "d".repeat(64) });
    const result = await runFixture();
    expect(result).toEqual({ kind: "noop", candidateIds: ["selected"] });
    expect(await countCandidates(root.dir)).toBe(201);
  });

  it("refuses concurrent drift from 199 to 200 after the fetch", async () => {
    await prepareUnrelatedQueue(199);
    let fetches = 0;
    const fetcher = async (): Promise<ConfinedFetchResult> => {
      fetches += 1;
      await plantConnectorCandidate(root.dir, "concurrent", { idempotencyKey: UNRELATED_KEY });
      return fixtureFetch();
    };

    const result = await runFixture({ fetcher });

    await expectUnavailableWithoutEvent(result);
    expect(fetches).toBe(1);
  });

  it("translates unexpected post-gate staged overflow", async () => {
    await prepareUnrelatedQueue(199);

    const result = await runLateOverflow();

    await expectUnavailableWithoutEvent(result);
  });

  it("restores a selected predecessor before translating late overflow", async () => {
    await prepareUnrelatedQueue(199);
    await plantConnectorCandidate(root.dir, "selected");

    const result = await runLateOverflow();

    expect(result).toEqual(STORE_UNAVAILABLE);
    expect(await readFile(path.join(root.dir, ".llmwiki", "candidates", "selected.json"), "utf8"))
      .toContain('"id":"selected"');
  });

  it("lets recovery-required win when late overflow cannot restore a predecessor", async () => {
    await prepareUnrelatedQueue(199);
    await plantConnectorCandidate(root.dir, "selected");

    const result = await runLateOverflow(true);

    expect(result).toEqual({ kind: "recovery-required", candidateIds: ["selected"] });
  });

  it("keeps direct selected identity mismatches typed", async () => {
    await plantConnectorCandidate(root.dir, "selected");
    await mismatch("selected");

    await expect(selectConnectorCandidateEntries(root.dir, FIXTURE_IDEMPOTENCY_KEY))
      .rejects.toBeInstanceOf(CandidateIdentityMismatchError);
  });

  it("maps a selected mismatch to unavailable before fetch", async () => {
    await activateFixtureConnector(root.dir);
    await plantConnectorCandidate(root.dir, "selected");
    await mismatch("selected");
    const fetches = { value: 0 };

    const result = await runCounted(fetches);

    expect(result).toEqual(STORE_UNAVAILABLE);
    expect(fetches.value).toBe(0);
  });

  it("preserves an unrelated mismatch byte-identically", async () => {
    await activateFixtureConnector(root.dir);
    await plantConnectorCandidate(root.dir, "unrelated", { idempotencyKey: UNRELATED_KEY });
    const bytes = await mismatch("unrelated");
    const file = path.join(root.dir, ".llmwiki", "candidates", "unrelated.json");

    const result = await runFixture();

    expect(result.kind).toBe("staged");
    expect(await readFile(file, "utf8")).toBe(bytes);
  });

  it("maps a mismatch introduced during fetch at the locked recheck", async () => {
    await activateFixtureConnector(root.dir);
    await plantConnectorCandidate(root.dir, "selected");
    const fetcher = async (): Promise<ConfinedFetchResult> => {
      await mismatch("selected");
      return fixtureFetch();
    };

    const result = await runFixture({ fetcher });

    expect(result).toEqual(STORE_UNAVAILABLE);
  });
});

/**
 * @file test/connectors/final11-candidate-access.test.ts
 * @description Decision 20 connector regressions require effective read/search
 * and plan-aware write/search checks before rate state or external fetch.
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConnector } from "../../src/connectors/run.js";
import { readEvents } from "../../src/events/store-read.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { plantConnectorCandidate } from "./final6-fixtures.js";
import { activateFixtureConnector, countedFixtureFetch } from "./run-test-fixtures.js";

const root = useTempRoot();
const CAN_TEST_POSIX_MODES = process.platform !== "win32" && process.getuid?.() !== 0;
const STORE_UNAVAILABLE = Object.freeze({
  kind: "unavailable" as const,
  reason: "connector candidate store unavailable",
});

/** Ensure a misplaced gate leaves a detectable durable rate receipt. */
async function requireRateStamp(): Promise<void> {
  const file = path.join(root.dir, ".llmwiki", "config.json");
  const current = JSON.parse(await readFile(file, "utf8"));
  current.connectors.fixture.minRequestIntervalMs = 1_000;
  await writeFile(file, JSON.stringify(current));
}

/** Run the fixture connector and assert every pre-effect observation is empty. */
async function expectRefusalBeforeEffects(fetches: { value: number }): Promise<void> {
  const result = await runConnector(root.dir, "fixture", { id: "story-1" }, {
    fetcher: countedFixtureFetch(fetches),
  });
  expect(result).toEqual(STORE_UNAVAILABLE);
  expect(fetches.value).toBe(0);
  expect((await readEvents(root.dir)).events).toEqual([]);
  expect(existsSync(path.join(root.dir, ".llmwiki/connectors/fixture.last-fetch.json")))
    .toBe(false);
}

describe.runIf(CAN_TEST_POSIX_MODES)("Decision 20 connector candidate access", () => {
  afterEach(() => { delete process.env.LLMWIKI_CONNECTORS; });

  it("refuses an archive without search access before rate or fetch", async () => {
    await activateFixtureConnector(root.dir);
    await requireRateStamp();
    const archive = path.join(root.dir, ".llmwiki", "candidates", "archive");
    await mkdir(archive, { recursive: true });
    await chmod(archive, 0o444);
    const fetches = { value: 0 };

    try {
      await expectRefusalBeforeEffects(fetches);
    } finally {
      await chmod(archive, 0o700);
    }
    expect(await readdir(archive)).toEqual([]);
  });

  it("refuses a selected archive without insertion access before effects", async () => {
    await activateFixtureConnector(root.dir);
    await requireRateStamp();
    await plantConnectorCandidate(root.dir, "selected");
    const pending = path.join(root.dir, ".llmwiki", "candidates", "selected.json");
    const before = await readFile(pending, "utf8");
    const archive = path.join(root.dir, ".llmwiki", "candidates", "archive");
    await mkdir(archive, { recursive: true });
    await chmod(archive, 0o555);
    const fetches = { value: 0 };

    try {
      await expectRefusalBeforeEffects(fetches);
    } finally {
      await chmod(archive, 0o700);
    }
    expect(await readFile(pending, "utf8")).toBe(before);
    expect(await readdir(archive)).toEqual([]);
  });
});

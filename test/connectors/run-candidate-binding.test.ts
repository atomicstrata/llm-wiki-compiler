/**
 * @file test/connectors/run-candidate-binding.test.ts
 * @description Connector preflight and locked supersession must preserve the
 * candidate store's filename/record binding through audit, archive, and undo.
 */

import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfinedFetchResult } from "../../src/connectors/confined-fetch.js";
import { runConnector } from "../../src/connectors/run.js";
import { readEvents } from "../../src/events/store-read.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { activateFixtureConnector, invalidateFixtureHeadlineType } from "./run-test-fixtures.js";

const root = useTempRoot();
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** Return one deterministic fixture response and count whether fetch occurred. */
function countedFetch(counter: { value: number }, contentHash: string) {
  return async (): Promise<ConfinedFetchResult> => {
    counter.value += 1;
    return {
      kind: "ok",
      finalUrl: "https://fixture.local/story-1",
      bytes: Buffer.from("{}"),
      contentHash,
    };
  };
}

/** Run the fixture connector with a supplied content hash. */
function runFixture(contentHash: string, counter = { value: 0 }) {
  return runConnector(root.dir, "fixture", { id: "story-1" }, {
    fetcher: countedFetch(counter, contentHash),
  });
}

/** Return the only regular pending filename identity. */
async function onlyPendingFileId(): Promise<string> {
  const names = await readdir(candidateDir());
  const files = names.filter((name) => name.endsWith(".json"));
  expect(files).toHaveLength(1);
  return files[0]!.slice(0, -5);
}

/** Rewrite a selected candidate while retaining its connector provenance. */
async function rewriteCandidate(fileId: string, recordId: string): Promise<void> {
  const file = path.join(candidateDir(), `${fileId}.json`);
  const record = JSON.parse(await readFile(file, "utf8"));
  record.id = recordId;
  await writeFile(file, JSON.stringify(record, null, 2));
}

/** Clone a selected candidate under a fully bound second filename. */
async function cloneBoundCandidate(fileId: string, cloneId: string): Promise<void> {
  const record = JSON.parse(await readFile(path.join(candidateDir(), `${fileId}.json`), "utf8"));
  record.id = cloneId;
  record.generatedAt = "2026-01-02T00:00:00.000Z";
  await writeFile(path.join(candidateDir(), `${cloneId}.json`), JSON.stringify(record, null, 2));
}

/** Snapshot every regular file beneath the pending and archive roots. */
async function snapshotCandidateStore(): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const relativeDir of ["", "archive"]) {
    const dir = path.join(candidateDir(), relativeDir);
    let names: string[];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
      const key = path.join(relativeDir, name);
      snapshot[key] = (await readFile(path.join(dir, name))).toString("base64");
    }
  }
  return snapshot;
}

/** Seed the initial selected record and return its filename identity. */
async function seedSelectedCandidate(): Promise<string> {
  await expect(runFixture(HASH_A)).resolves.toMatchObject({ kind: "staged" });
  return onlyPendingFileId();
}

/** Assert a malformed selected batch returns unavailable before fetch without writes. */
async function expectPrefetchRefusal(): Promise<void> {
  const before = await snapshotCandidateStore();
  const counter = { value: 0 };
  await expect(runFixture(HASH_B, counter)).resolves.toEqual({
    kind: "unavailable", reason: "connector candidate store unavailable",
  });
  expect(counter.value).toBe(0);
  expect(await snapshotCandidateStore()).toEqual(before);
}

function candidateDir(): string {
  return path.join(root.dir, ".llmwiki", "candidates");
}

describe("connector candidate locator binding", () => {
  afterEach(() => { delete process.env.LLMWIKI_CONNECTORS; });

  it("refuses a selected record naming another pending filename before fetch", async () => {
    await activateFixtureConnector(root.dir);
    const fileId = await seedSelectedCandidate();
    await rewriteCandidate(fileId, "victim-file");
    await writeFile(path.join(candidateDir(), "victim-file.json"), JSON.stringify({
      id: "victim-file", title: "Victim", slug: "other", sources: [], body: "body",
      generatedAt: "2026-01-03T00:00:00.000Z",
    }));

    await expectPrefetchRefusal();
  });

  it("refuses an absent embedded destination before fetch", async () => {
    await activateFixtureConnector(root.dir);
    const fileId = await seedSelectedCandidate();
    await rewriteCandidate(fileId, "absent-file");

    await expectPrefetchRefusal();
  });

  it("validates a mixed selected batch before any archive", async () => {
    await activateFixtureConnector(root.dir);
    const fileId = await seedSelectedCandidate();
    await cloneBoundCandidate(fileId, "valid-clone");
    await rewriteCandidate(fileId, "absent-file");

    await expectPrefetchRefusal();
  });

  it("revalidates selected identities after fetch under the project lock", async () => {
    await activateFixtureConnector(root.dir);
    const fileId = await seedSelectedCandidate();
    const counter = { value: 0 };
    const fetcher = async (): Promise<ConfinedFetchResult> => {
      counter.value += 1;
      await rewriteCandidate(fileId, "post-fetch-mismatch");
      return countedFetch({ value: 0 }, HASH_B)();
    };

    await expect(runConnector(root.dir, "fixture", { id: "story-1" }, { fetcher }))
      .resolves.toEqual({ kind: "unavailable", reason: "connector candidate store unavailable" });

    expect(counter.value).toBe(1);
    expect(Object.keys(await snapshotCandidateStore())).toEqual([`${fileId}.json`]);
  });

  it.each([
    ["reserved filename", true],
    ["reserved record id", false],
  ])("refuses a selected %s before fetch", async (_label, reserveFilename) => {
    await activateFixtureConnector(root.dir);
    const fileId = await seedSelectedCandidate();
    if (reserveFilename) {
      await rename(path.join(candidateDir(), `${fileId}.json`), path.join(candidateDir(), "BND_legacy.json"));
    } else {
      await rewriteCandidate(fileId, "BND_legacy-record");
    }

    await expectPrefetchRefusal();
  });

  it("reports bound filename ids in a no-op result and audit event", async () => {
    await activateFixtureConnector(root.dir);
    const fileId = await seedSelectedCandidate();

    await expect(runFixture(HASH_A)).resolves.toEqual({ kind: "noop", candidateIds: [fileId] });
    const { events } = await readEvents(root.dir);
    expect(events.at(-1)?.payload).toMatchObject({ noopCandidateIds: [fileId] });
  });

  it("archives every bound filename and reports the same audit identities", async () => {
    await activateFixtureConnector(root.dir);
    const fileId = await seedSelectedCandidate();
    await cloneBoundCandidate(fileId, "valid-clone");

    const result = await runFixture(HASH_B);
    expect(result).toMatchObject({ kind: "superseded" });
    if (result.kind !== "superseded") throw new Error("expected superseded result");
    expect([...result.archivedIds].sort()).toEqual([fileId, "valid-clone"].sort());
    const { events } = await readEvents(root.dir);
    const eventIds = events.at(-1)?.payload.supersededCandidateIds as string[];
    expect([...eventIds].sort()).toEqual([...result.archivedIds].sort());
  });

  it("restores exact filename bytes when replacement staging fails", async () => {
    await activateFixtureConnector(root.dir);
    const fileId = await seedSelectedCandidate();
    await cloneBoundCandidate(fileId, "valid-clone");
    const before = await snapshotCandidateStore();
    await invalidateFixtureHeadlineType(root.dir);

    await expect(runFixture(HASH_B)).rejects.toThrow();

    expect(await snapshotCandidateStore()).toEqual(before);
  });

  it("ignores an unrelated mismatch and preserves its exact bytes", async () => {
    await activateFixtureConnector(root.dir);
    await seedSelectedCandidate();
    await writeFile(path.join(candidateDir(), "other-file.json"), JSON.stringify({
      id: "other-record", title: "Other", slug: "other", sources: [], body: "body",
      generatedAt: "2026-01-03T00:00:00.000Z",
    }));
    const before = (await snapshotCandidateStore())["other-file.json"];

    await expect(runFixture(HASH_B)).resolves.toMatchObject({ kind: "superseded" });

    expect((await snapshotCandidateStore())["other-file.json"]).toBe(before);
  });
});

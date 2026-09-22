/**
 * @file test/candidate-mutation-capacity-final7.test.ts
 * @description Public writers retain their record-size behavior while new
 * strict custody interfaces enforce their explicit bounded-authority contract.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readCandidate,
  archiveCandidate,
  deleteCandidate,
  writeCandidate,
  writeFreshCandidate,
  type CandidateDraft,
} from "../src/compiler/candidates.js";
import { captureCandidateCustody, CandidateCustodyUnavailableError,
  MAX_CANDIDATE_RECORD_BYTES } from "../src/compiler/candidate-custody.js";
import { listCandidates } from "../src/compiler/candidate-read.js";
import { selectConnectorCandidateEntriesForRun } from "../src/connectors/candidate-supersession.js";
import type { ConfinedFetchResult } from "../src/connectors/confined-fetch.js";
import { runConnector } from "../src/connectors/run.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { plantConnectorCandidate } from "./connectors/final6-fixtures.js";
import { activateFixtureConnector } from "./connectors/run-test-fixtures.js";

const root = useTempRoot();
const SLUG = "capacity";

/** Build the minimal draft used for exact serialized-size fixtures. */
function draft(body: string): CandidateDraft {
  return { title: SLUG, slug: SLUG, summary: "", sources: [], body };
}

/** Compute a body whose normal candidate record has exactly `size` bytes. */
function bodyForRecordSize(size: number): string {
  const record = {
    id: `${SLUG}-${"0".repeat(8)}`, title: SLUG, slug: SLUG, summary: "",
    sources: [], body: "", generatedAt: "2000-01-01T00:00:00.000Z",
    reviewMode: "forced", heldReasons: [{ code: "manual-review-requested" }],
  };
  const base = Buffer.byteLength(JSON.stringify(record, null, 2));
  return "x".repeat(size - base);
}

/** Deterministic response used only if a pre-fetch gate incorrectly passes. */
function fixtureFetch(): Promise<ConfinedFetchResult> {
  return Promise.resolve({
    kind: "ok", finalUrl: "https://fixture.local/story-1",
    bytes: Buffer.from("{}"), contentHash: "a".repeat(64),
  });
}

describe("Final7 candidate mutation capacity", () => {
  afterEach(() => { delete process.env.LLMWIKI_CONNECTORS; });

  it("writes and reads back an exact-cap candidate", async () => {
    const candidate = await writeFreshCandidate(
      root.dir, draft(bodyForRecordSize(MAX_CANDIDATE_RECORD_BYTES)),
    );
    const file = path.join(root.dir, ".llmwiki", "candidates", `${candidate.id}.json`);

    expect((await stat(file)).size).toBe(MAX_CANDIDATE_RECORD_BYTES);
    expect((await readCandidate(root.dir, candidate.id))?.id).toBe(candidate.id);
  });

  it.each([
    ["canonical", writeCandidate],
    ["fresh", writeFreshCandidate],
  ] as const)("retains cap-plus-one support in the public %s writer", async (_name, writer) => {
    const body = bodyForRecordSize(MAX_CANDIDATE_RECORD_BYTES + 1);

    const candidate = await writer(root.dir, draft(body));
    expect((await listCandidates(root.dir))[0]?.body).toBe(body);
    await expect(captureCandidateCustody(root.dir, candidate.id))
      .rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
    await expect(archiveCandidate(root.dir, candidate.id)).resolves.toBe(true);
  });

  it("supports public records whose JSON escaping exceeds the strict byte cap", async () => {
    const body = "\u0000".repeat(700_000);
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_CANDIDATE_RECORD_BYTES);

    const candidate = await writeFreshCandidate(root.dir, draft(body));
    expect((await readCandidate(root.dir, candidate.id))?.body).toBe(body);
    await expect(deleteCandidate(root.dir, candidate.id)).resolves.toBe(true);
  });

  it("canonicalizes large revisions under the original public candidate identity", async () => {
    const first = await writeCandidate(root.dir, draft("small"));
    const body = "x".repeat(MAX_CANDIDATE_RECORD_BYTES);
    expect((await writeCandidate(root.dir, draft(body))).id).toBe(first.id);
    expect((await writeCandidate(root.dir, draft("small again"))).id).toBe(first.id);
    expect(await listCandidates(root.dir)).toHaveLength(1);
  });

  it("keeps normal connector discovery tolerant of unrelated malformed records", async () => {
    await activateFixtureConnector(root.dir);
    const dir = path.join(root.dir, ".llmwiki", "candidates");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "broken.json"), "{not-json");
    let fetches = 0;

    const result = await runConnector(root.dir, "fixture", { id: "story-1" }, {
      fetcher: async () => { fetches += 1; return fixtureFetch(); },
    });

    expect(result.kind).toBe("staged");
    expect(fetches).toBe(1);
    expect(await listCandidates(root.dir)).toHaveLength(1);
  });

  it("can inspect 201 unrelated candidates without authorizing another staged write", async () => {
    for (let index = 0; index < 201; index += 1) {
      await plantConnectorCandidate(root.dir, `unrelated-${index}`, {
        idempotencyKey: "b".repeat(64),
      });
    }

    const result = await selectConnectorCandidateEntriesForRun(root.dir, "a".repeat(64));

    expect(result).toMatchObject({ entries: [], totalPending: 201 });
  });

  it("does not count unrelated directory entries as connector mutation authority", async () => {
    const dir = path.join(root.dir, ".llmwiki", "candidates");
    await mkdir(path.join(dir, "archive"), { recursive: true });
    await Promise.all(Array.from({ length: 201 }, (_, index) =>
      writeFile(path.join(dir, `noise-${index}.txt`), "x")));

    const result = await selectConnectorCandidateEntriesForRun(root.dir, "a".repeat(64));

    expect(result).toMatchObject({ entries: [], totalPending: 0 });
  });
});

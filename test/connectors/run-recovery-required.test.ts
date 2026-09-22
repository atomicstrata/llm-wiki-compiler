/**
 * @file test/connectors/run-recovery-required.test.ts
 * @description Connector staging and CLI rendering give incomplete candidate
 * restoration a typed, nonzero, filename-bound recovery outcome.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectorRunCommand } from "../../src/commands/connector.js";
import { moveCandidateWithCustody } from "../../src/compiler/candidate-custody.js";
import type { ConfinedFetchResult } from "../../src/connectors/confined-fetch.js";
import { runConnector } from "../../src/connectors/run.js";
import type { CandidateMovePort } from "../../src/connectors/candidate-supersession.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { activateFixtureConnector } from "./run-test-fixtures.js";

const root = useTempRoot();
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** Return one deterministic connector fetch response. */
function fixtureFetch(contentHash: string): Promise<ConfinedFetchResult> {
  return Promise.resolve({
    kind: "ok",
    finalUrl: "https://fixture.local/story-1",
    bytes: Buffer.from("{}"),
    contentHash,
  });
}

/** Run the fixture connector with an optional candidate move port. */
function runFixture(contentHash: string, candidateMoves?: CandidateMovePort) {
  return runConnector(root.dir, "fixture", { id: "story-1" }, {
    fetcher: () => fixtureFetch(contentHash),
    candidateMoves,
    // Fail after archival, not during the newer public profile validation.
    beforeCandidateStageForTest: contentHash === HASH_B
      ? async () => { throw new Error("synthetic staging failure"); } : undefined,
  } as Parameters<typeof runConnector>[3]);
}

/** Return the sole pending candidate filename identity. */
async function onlyPendingId(): Promise<string> {
  const dir = path.join(root.dir, ".llmwiki", "candidates");
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  expect(names).toHaveLength(1);
  return names[0]!.slice(0, -5);
}

/** Archive normally but make every compensation report false. */
function failedRestoreMover(): CandidateMovePort {
  return {
    async move(request) {
      if (request.direction === "restore") return false;
      return moveCandidateWithCustody(request);
    },
  };
}

/** Seed one selected candidate, then make replacement staging fail. */
async function seedCandidateBeforeStagingFailure(): Promise<string> {
  await activateFixtureConnector(root.dir);
  await expect(runFixture(HASH_A)).resolves.toMatchObject({ kind: "staged" });
  const fileId = await onlyPendingId();
  return fileId;
}

describe("connector recovery-required result", () => {
  afterEach(() => {
    delete process.env.LLMWIKI_CONNECTORS;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("takes precedence over the original staging error when restore fails", async () => {
    const fileId = await seedCandidateBeforeStagingFailure();

    const result = await runFixture(HASH_B, failedRestoreMover());

    expect(result).toEqual({ kind: "recovery-required", candidateIds: [fileId] });
    const archived = path.join(root.dir, ".llmwiki", "candidates", "archive", `${fileId}.json`);
    expect(JSON.parse(await readFile(archived, "utf8")).id).toBe(fileId);
  });

  it("rethrows the staging error after observable normal compensation", async () => {
    const fileId = await seedCandidateBeforeStagingFailure();

    await expect(runFixture(HASH_B)).rejects.toThrow("synthetic staging failure");

    expect(await onlyPendingId()).toBe(fileId);
  });

  it("renders bounded exact recovery ids and sets a nonzero CLI exit", async () => {
    const fileId = "candidate-file-1";
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => { lines.push(String(line)); });
    const command = connectorRunCommand as unknown as (
      id: string,
      options: object,
      root: string,
      deps: { runner: () => Promise<unknown> },
    ) => Promise<void>;

    await command("fixture", {}, root.dir, {
      runner: async () => ({ kind: "recovery-required", candidateIds: [fileId] }),
    });

    expect(process.exitCode).toBe(1);
    expect(lines.join("\n")).toContain("recovery-required");
    expect(lines.join("\n")).toContain(fileId);
  });
});

/**
 * @file test/connectors/candidate-supersession-recovery.test.ts
 * @description Connector supersession reports every archive compensation and
 * never collapses a partially restored candidate queue into a boolean result.
 */

import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { archivePath, candidatePath } from "../../src/compiler/candidate-paths.js";
import {
  moveCandidateWithCustody,
  type CandidateCustodyMoveRequest,
  type CandidateCustodyReceipt,
} from "../../src/compiler/candidate-custody.js";
import { selectCandidateEntriesForMutation } from "../../src/compiler/candidate-selection.js";
import {
  archiveCandidatesWithUndo,
  restoreArchivedCandidates,
  type CandidateMovePort,
} from "../../src/connectors/candidate-supersession.js";
import type { ReviewCandidate } from "../../src/utils/types.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const root = useTempRoot();

/** Build one complete bound candidate record. */
function candidateRecord(fileId: string): ReviewCandidate {
  return {
    id: fileId,
    title: fileId,
    slug: fileId,
    summary: "",
    sources: [],
    body: "---\ntitle: Fixture\n---\nBody\n",
    generatedAt: "2026-01-01T00:00:00.000Z",
    reviewMode: "connector",
    heldReasons: [{ code: "connector-fetched" }],
  };
}

/** Plant exact pending records and return their custody-bound entries. */
async function plantEntries(fileIds: readonly string[]) {
  await mkdir(pendingDir(), { recursive: true });
  for (const fileId of fileIds) {
    await writeFile(pendingFile(fileId), JSON.stringify(candidateRecord(fileId)));
  }
  return selectCandidateEntriesForMutation(root.dir, () => true);
}

/** Return regular pending/archive filenames for exact state assertions. */
async function storeFiles(): Promise<{ pending: string[]; archived: string[] }> {
  return {
    pending: await regularJsonNames(pendingDir()),
    archived: await regularJsonNames(archiveDir()),
  };
}

/** List regular JSON leaves, treating an absent directory as empty. */
async function regularJsonNames(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const names = await readdir(dir, { withFileTypes: true });
  return names.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name).sort();
}

/** Script one archive failure and selected restore failures over real moves. */
function scriptedMover(
  archiveFailureId: string,
  restoreFailures: Readonly<Record<string, "false" | "throw">> = {},
): CandidateMovePort {
  return {
    async move(request) {
      if (request.direction === "archive" && request.fileId === archiveFailureId) return false;
      const failure = restoreFailures[request.fileId];
      if (request.direction === "restore" && failure === "false") return false;
      if (request.direction === "restore" && failure === "throw") throw new Error("injected restore failure");
      return moveCandidateWithCustody(request);
    },
  };
}

/** Resolve the destination selected by one store-owned move request. */
async function moveDestination(request: CandidateCustodyMoveRequest): Promise<string> {
  return request.direction === "archive"
    ? archivePath(request.root, request.fileId)
    : candidatePath(request.root, request.fileId);
}

/** Extract internal receipts from one successful archive result. */
function receiptsFrom(result: Awaited<ReturnType<typeof archiveCandidatesWithUndo>>): readonly CandidateCustodyReceipt[] {
  if (result.kind !== "archived") throw new Error(`expected archived, got ${result.kind}`);
  return result.receipts;
}

function pendingDir(): string {
  return path.join(root.dir, ".llmwiki", "candidates");
}

function archiveDir(): string {
  return path.join(pendingDir(), "archive");
}

function pendingFile(fileId: string): string {
  return path.join(pendingDir(), `${fileId}.json`);
}

function archiveFile(fileId: string): string {
  return path.join(archiveDir(), `${fileId}.json`);
}

describe("connector candidate archive compensation", () => {
  it("returns failed-and-restored after a second archive fails", async () => {
    const entries = await plantEntries(["first", "second"]);

    const result = await archiveCandidatesWithUndo(root.dir, entries, scriptedMover("second"));

    expect(result).toEqual({ kind: "failed-and-restored" });
    expect(await storeFiles()).toEqual({ pending: ["first.json", "second.json"], archived: [] });
  });

  it.each(["false", "throw"] as const)(
    "returns recovery-required when restore returns %s",
    async (failure) => {
      const entries = await plantEntries(["first", "second"]);

      const result = await archiveCandidatesWithUndo(
        root.dir, entries, scriptedMover("second", { first: failure }),
      );

      expect(result).toEqual({ kind: "recovery-required", candidateIds: ["first"] });
      expect(await storeFiles()).toEqual({ pending: ["second.json"], archived: ["first.json"] });
    },
  );

  it("collects every failed restore in validated filename order", async () => {
    const entries = await plantEntries(["first", "second", "third"]);
    const mover = scriptedMover("third", { first: "false", second: "throw" });

    const result = await archiveCandidatesWithUndo(root.dir, entries, mover);

    expect(result).toEqual({ kind: "recovery-required", candidateIds: ["first", "second"] });
    expect(await storeFiles()).toEqual({ pending: ["third.json"], archived: ["first.json", "second.json"] });
  });

  it("detects a conflicting pending leaf even when restore reports success", async () => {
    const entries = await plantEntries(["first", "second"]);
    const mover = scriptedMover("second");
    const conflicting: CandidateMovePort = {
      async move(request) {
        if (request.direction === "restore") {
          await mkdir(await moveDestination(request), { recursive: true });
          return true;
        }
        return mover.move(request);
      },
    };

    const result = await archiveCandidatesWithUndo(root.dir, entries, conflicting);

    expect(result).toEqual({ kind: "recovery-required", candidateIds: ["first"] });
    expect((await lstat(pendingFile("first"))).isDirectory()).toBe(true);
    expect(await readFile(archiveFile("first"), "utf8")).toContain('"id":"first"');
  });

  it("preflights every destination kind before the first archive move", async () => {
    const entries = await plantEntries(["first", "second"]);
    await mkdir(archiveFile("second"), { recursive: true });
    let moves = 0;
    const mover: CandidateMovePort = { move: async () => { moves += 1; return true; } };

    const result = await archiveCandidatesWithUndo(root.dir, entries, mover);

    expect(result).toEqual({ kind: "recovery-required", candidateIds: ["second"] });
    expect(moves).toBe(0);
    expect(await regularJsonNames(pendingDir())).toEqual(["first.json", "second.json"]);
  });

  it("reports direct compensation failure instead of resolving void", async () => {
    const entries = await plantEntries(["first"]);
    const receipts = receiptsFrom(await archiveCandidatesWithUndo(root.dir, entries));
    const mover: CandidateMovePort = { move: async () => false };

    const result = await restoreArchivedCandidates(root.dir, receipts, mover);

    expect(result).toEqual({ kind: "recovery-required", candidateIds: ["first"] });
    expect(await storeFiles()).toEqual({ pending: [], archived: ["first.json"] });
  });
});

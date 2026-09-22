/**
 * @file test/connectors/final7-custody-snapshots.test.ts
 * @description Decision 15 regressions make candidate custody receipts,
 * requests, batch inputs, and restoration outcomes runtime immutable.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  moveCandidateWithCustody,
  observeCandidateCustody,
  type CandidateCustodyReceipt,
} from "../../src/compiler/candidate-custody.js";
import { selectCandidateEntriesForMutation } from "../../src/compiler/candidate-selection.js";
import type { CandidateFileEntry } from "../../src/compiler/candidate-read.js";
import {
  archiveCandidatesWithUndo,
  restoreArchivedCandidates,
  type CandidateMovePort,
} from "../../src/connectors/candidate-supersession.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { plantConnectorCandidate } from "./final6-fixtures.js";

const root = useTempRoot();
const outside = useTempRoot();
const FILE_ID = "candidate-one";

/** Plant and select one exact mutation-authority entry. */
async function selectedEntry() {
  await plantConnectorCandidate(root.dir, FILE_ID);
  const entries = await selectCandidateEntriesForMutation(root.dir, () => true);
  expect(entries).toHaveLength(1);
  return entries[0]!;
}

/** Return the archive leaf for the fixed candidate. */
function archiveFile(): string {
  return path.join(root.dir, ".llmwiki", "candidates", "archive", `${FILE_ID}.json`);
}

/** Extract one successful archive receipt. */
function receiptFrom(result: Awaited<ReturnType<typeof archiveCandidatesWithUndo>>) {
  if (result.kind !== "archived") throw new Error(`expected archived, got ${result.kind}`);
  return result.receipts[0]!;
}

describe("Final7 immutable candidate custody", () => {
  it("returns deeply frozen selection evidence", async () => {
    const { custodyReceipt } = await selectedEntry();

    expect(Object.isFrozen(custodyReceipt)).toBe(true);
    expect(Object.isFrozen(custodyReceipt.fileIdentity)).toBe(true);
    expect(Object.isFrozen(custodyReceipt.storeIdentity)).toBe(true);
  });

  it("returns a frozen receipt array after archive", async () => {
    const entry = await selectedEntry();
    const result = await archiveCandidatesWithUndo(root.dir, [entry]);
    if (result.kind !== "archived") throw new Error(`expected archived, got ${result.kind}`);

    expect(Object.isFrozen(result.receipts)).toBe(true);
    expect(Object.isFrozen(result.receipts[0])).toBe(true);
  });

  it("prevents a move seam from changing the recovery identity", async () => {
    const entry = await selectedEntry();
    let requestFrozen = false;
    const mover: CandidateMovePort = { move: async (request) => {
      requestFrozen = Object.isFrozen(request) && Object.isFrozen(request.receipt);
      try { (request.receipt as { fileId: string }).fileId = "other-safe"; } catch {}
      try { (request.receipt.fileIdentity as { ino: number }).ino = 99; } catch {}
      return false;
    } };

    const result = await archiveCandidatesWithUndo(root.dir, [entry], mover);

    expect(requestFrozen).toBe(true);
    expect(result).toEqual({ kind: "failed-and-restored" });
    expect(await observeCandidateCustody(root.dir, entry.custodyReceipt)).toBe("restored");
  });

  it("uses the captured request after the caller mutates its live object", async () => {
    const entry = await selectedEntry();
    const receipt = {
      ...entry.custodyReceipt,
      fileIdentity: { ...entry.custodyReceipt.fileIdentity },
      storeIdentity: { ...entry.custodyReceipt.storeIdentity },
    };
    const request = { root: root.dir, fileId: FILE_ID, direction: "archive" as const, receipt };

    const moving = moveCandidateWithCustody(request);
    request.root = outside.dir;
    receipt.fileIdentity.ino += 1;

    await expect(moving).resolves.toBe(true);
    expect(await observeCandidateCustody(root.dir, entry.custodyReceipt)).toBe("archived");
  });

  it("rejects an accessor receipt before invoking the restore mover", async () => {
    const entry = await selectedEntry();
    const receipt = receiptFrom(await archiveCandidatesWithUndo(root.dir, [entry]));
    let reads = 0;
    let moves = 0;
    const hostile = Object.defineProperty({ ...receipt }, "fileId", {
      enumerable: true, get: () => { reads += 1; return FILE_ID; },
    });
    const mover: CandidateMovePort = { move: async () => { moves += 1; return true; } };

    await expect(restoreArchivedCandidates(root.dir, [hostile as CandidateCustodyReceipt], mover))
      .rejects.toMatchObject({ name: "CandidateCustodyBoundaryError" });
    expect({ reads, moves }).toEqual({ reads: 0, moves: 0 });
  });

  it("rejects a proxy receipt array before invoking the mover", async () => {
    const entry = await selectedEntry();
    const receipt = receiptFrom(await archiveCandidatesWithUndo(root.dir, [entry]));
    let moves = 0;
    const receipts = new Proxy([receipt], {});
    const mover: CandidateMovePort = { move: async () => { moves += 1; return true; } };

    await expect(restoreArchivedCandidates(root.dir, receipts, mover))
      .rejects.toMatchObject({ name: "CandidateCustodyBoundaryError" });
    expect(moves).toBe(0);
  });

  it("rejects a proxy archive-entry array before invoking the mover", async () => {
    const entry = await selectedEntry();
    let moves = 0;
    const entries = new Proxy([entry], {});
    const mover: CandidateMovePort = { move: async () => { moves += 1; return true; } };

    await expect(archiveCandidatesWithUndo(root.dir, entries, mover))
      .rejects.toMatchObject({ name: "CandidateCustodyBoundaryError" });
    expect(moves).toBe(0);
  });

  it("rejects an archive-entry accessor without invoking it", async () => {
    const entry = await selectedEntry();
    let reads = 0;
    const hostile = Object.defineProperty({ ...entry }, "fileId", {
      enumerable: true, get: () => { reads += 1; return FILE_ID; },
    });

    await expect(archiveCandidatesWithUndo(root.dir, [hostile as CandidateFileEntry]))
      .rejects.toMatchObject({ name: "CandidateCustodyBoundaryError" });
    expect(reads).toBe(0);
  });

  it("restores an already-archived preflight receipt before claiming restoration", async () => {
    const entry = await selectedEntry();
    await moveCandidateWithCustody({
      root: root.dir, fileId: FILE_ID, direction: "archive", receipt: entry.custodyReceipt,
    });

    const result = await archiveCandidatesWithUndo(root.dir, [entry]);

    expect(result).toEqual({ kind: "failed-and-restored" });
    expect(await observeCandidateCustody(root.dir, entry.custodyReceipt)).toBe("restored");
    expect(existsSync(archiveFile())).toBe(false);
  });

  it("parks a conflicting preflight receipt under its exact filename", async () => {
    const entry = await selectedEntry();
    await mkdir(path.dirname(archiveFile()), { recursive: true });
    await writeFile(archiveFile(), "conflict");

    const result = await archiveCandidatesWithUndo(root.dir, [entry]);

    expect(result).toEqual({ kind: "recovery-required", candidateIds: [FILE_ID] });
    expect(await observeCandidateCustody(root.dir, entry.custodyReceipt)).toBe("conflict");
  });
});

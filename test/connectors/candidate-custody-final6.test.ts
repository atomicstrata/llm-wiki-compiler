/**
 * @file test/connectors/candidate-custody-final6.test.ts
 * @description Final6 candidate custody tests require bounded raw-byte
 * receipts, store-owned moves, exact post-observation, and closed recovery.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { archivePath, candidatePath } from "../../src/compiler/candidate-paths.js";
import {
  MAX_CANDIDATE_RECORD_BYTES,
  CandidateCustodyUnavailableError,
  moveCandidateWithCustody,
  type CandidateCustodyMoveRequest,
  type CandidateCustodyReceipt,
} from "../../src/compiler/candidate-custody.js";
import {
  ConnectorCandidateBatchOverflowError,
} from "../../src/connectors/candidate-batch.js";
import {
  archiveCandidatesWithUndo,
  restoreArchivedCandidates,
  selectConnectorCandidateEntries,
  type CandidateMovePort,
} from "../../src/connectors/candidate-supersession.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import {
  connectorCandidateRecord,
  FIXTURE_IDEMPOTENCY_KEY,
  plantConnectorCandidate,
} from "./final6-fixtures.js";

const root = useTempRoot();
const outside = useTempRoot();
const FILE_ID = "custody-candidate";

/** Select the planted fixture through the production mutation reader. */
async function selectFixture() {
  return selectConnectorCandidateEntries(root.dir, FIXTURE_IDEMPOTENCY_KEY);
}

/** Archive one planted fixture through the production move primitive. */
async function archiveFixture() {
  await plantConnectorCandidate(root.dir, FILE_ID);
  return archiveCandidatesWithUndo(root.dir, await selectFixture());
}

/** Narrow a successful archive result to its internal receipts. */
function archivedReceipts(result: Awaited<ReturnType<typeof archiveFixture>>): readonly CandidateCustodyReceipt[] {
  if (result.kind !== "archived") throw new Error(`expected archived, got ${result.kind}`);
  return result.receipts;
}

/** Resolve the source and destination selected by one store-owned move request. */
async function movePaths(request: CandidateCustodyMoveRequest): Promise<[string, string]> {
  const pending = await candidatePath(request.root, request.fileId);
  const archived = await archivePath(request.root, request.fileId);
  return request.direction === "archive" ? [pending, archived] : [archived, pending];
}

/** Replace a source with wrong destination bytes while reporting success. */
function corruptingMovePort(): CandidateMovePort {
  return {
    async move(request) {
      const [source, destination] = await movePaths(request);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, "CORRUPTED");
      await unlink(source);
      return true;
    },
  };
}

/** Swap the candidate parent, then delegate to the real store-owned primitive. */
function swappingProductionPort(originalDir: string): CandidateMovePort {
  return {
    async move(request) {
      const candidateDir = path.join(request.root, ".llmwiki", "candidates");
      await rename(candidateDir, originalDir);
      await mkdir(outside.dir, { recursive: true });
      await writeFile(path.join(outside.dir, `${request.fileId}.json`), "OUTSIDE-SENTINEL");
      await symlink(outside.dir, candidateDir, "dir");
      return moveCandidateWithCustody(request);
    },
  };
}

describe("Final6 connector candidate custody", () => {
  it("returns exact bounded receipts without retaining raw bytes", async () => {
    await plantConnectorCandidate(root.dir, FILE_ID);
    const raw = await readFile(await candidatePath(root.dir, FILE_ID));
    const result = await archiveCandidatesWithUndo(root.dir, await selectFixture());
    const [receipt] = archivedReceipts(result);

    expect(receipt).toMatchObject({
      fileId: FILE_ID,
      byteCount: raw.byteLength,
      sha256: createHash("sha256").update(raw).digest("hex"),
      fileIdentity: { dev: expect.any(Number), ino: expect.any(Number) },
    });
    expect(Object.keys(receipt!)).not.toContain("bytes");
  });

  it("never classifies wrong destination bytes as archived", async () => {
    await plantConnectorCandidate(root.dir, FILE_ID);
    const entries = await selectFixture();

    const result = await archiveCandidatesWithUndo(root.dir, entries, corruptingMovePort());

    expect(result).toEqual({ kind: "recovery-required", candidateIds: [FILE_ID] });
    expect(await readFile(await archivePath(root.dir, FILE_ID), "utf8")).toBe("CORRUPTED");
  });

  it("refuses an unreadable source before any archive move", async () => {
    await plantConnectorCandidate(root.dir, FILE_ID);
    const entries = await selectFixture();
    await chmod(await candidatePath(root.dir, FILE_ID), 0o000);
    const move = vi.fn(async () => true);
    const mover: CandidateMovePort = { move };

    const result = await archiveCandidatesWithUndo(root.dir, entries, mover);

    expect(result).toEqual({ kind: "recovery-required", candidateIds: [FILE_ID] });
    expect(move).not.toHaveBeenCalled();
  });

  it("never slurps an oversized mutation candidate", async () => {
    const dir = path.join(root.dir, ".llmwiki", "candidates");
    await mkdir(dir, { recursive: true });
    const record = JSON.stringify(connectorCandidateRecord(FILE_ID));
    const padding = " ".repeat(MAX_CANDIDATE_RECORD_BYTES + 1 - Buffer.byteLength(record));
    await writeFile(path.join(dir, `${FILE_ID}.json`), record + padding);

    await expect(selectFixture()).rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
  });

  it("keeps a post-archive path failure inside recovery precedence", async () => {
    const receipts = archivedReceipts(await archiveFixture());
    const candidateDir = path.join(root.dir, ".llmwiki", "candidates");
    await rename(candidateDir, path.join(root.dir, "hidden-candidates"));
    await symlink(outside.dir, candidateDir, "dir");

    const result = await restoreArchivedCandidates(root.dir, receipts);

    expect(result).toEqual({ kind: "recovery-required", candidateIds: [FILE_ID] });
  });

  it("rejects a swapped parent before the production primitive moves outside bytes", async () => {
    await plantConnectorCandidate(root.dir, FILE_ID);
    const entries = await selectFixture();
    const originalDir = path.join(root.dir, "original-candidates");
    const mover = swappingProductionPort(originalDir);

    const result = await archiveCandidatesWithUndo(root.dir, entries, mover);

    expect(result).toEqual({ kind: "recovery-required", candidateIds: [FILE_ID] });
    expect(await readFile(path.join(outside.dir, `${FILE_ID}.json`), "utf8"))
      .toBe("OUTSIDE-SENTINEL");
    expect(existsSync(path.join(outside.dir, "archive", `${FILE_ID}.json`))).toBe(false);
    expect(JSON.parse(await readFile(path.join(originalDir, `${FILE_ID}.json`), "utf8")).id)
      .toBe(FILE_ID);
  });

  it("rechecks the 200-entry cap at direct archive and restore boundaries", async () => {
    await plantConnectorCandidate(root.dir, FILE_ID);
    const [entry] = await selectFixture();
    const archived = archivedReceipts(await archiveCandidatesWithUndo(root.dir, [entry!]));
    const mover: CandidateMovePort = { move: async () => true };

    await expect(archiveCandidatesWithUndo(root.dir, Array(201).fill(entry), mover))
      .rejects.toBeInstanceOf(ConnectorCandidateBatchOverflowError);
    await expect(restoreArchivedCandidates(root.dir, Array(201).fill(archived[0]), mover))
      .rejects.toBeInstanceOf(ConnectorCandidateBatchOverflowError);
  });
});

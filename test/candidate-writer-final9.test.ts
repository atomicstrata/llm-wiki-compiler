/**
 * @file test/candidate-writer-final9.test.ts
 * @description Decision 19 regressions require both candidate writers to use
 * bounded collision-exclusive publication for every newly allocated identity,
 * while preserving only receipt-bound canonical same-target replacement.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FreshCandidateIdExhaustedError,
  writeCandidate,
  type CandidateDraft,
  type FreshCandidateWriteOptions,
} from "../src/compiler/candidates.js";
import { CandidateCustodyUnavailableError } from "../src/compiler/candidate-custody.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();
const COLLISION = "generic-collision";
const SECOND = "generic-second";

type GenericWriter = (
  root: string,
  draft: CandidateDraft,
  options?: FreshCandidateWriteOptions,
) => ReturnType<typeof writeCandidate>;

/** Minimal generic candidate draft. */
function draft(body = "new"): CandidateDraft {
  return { title: "Generic", slug: "generic", summary: "", sources: [], body };
}

/** Call the future options-bearing generic writer without weakening its public type. */
function writeGeneric(options: FreshCandidateWriteOptions) {
  return (writeCandidate as GenericWriter)(root.dir, draft(), options);
}

/** Plant exact authority in pending or archive. */
async function plant(location: "pending" | "archive", id: string, bytes: string): Promise<string> {
  const dir = path.join(root.dir, ".llmwiki", "candidates", ...(location === "archive" ? ["archive"] : []));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  const record = {
    id, title: "Manual", slug: "manual", summary: "", sources: [], body: bytes,
    generatedAt: "2026-01-01T00:00:00.000Z", reviewMode: "forced", heldReasons: [],
  };
  await writeFile(file, JSON.stringify(record));
  return file;
}

/** Deterministic identities for bounded allocator tests. */
function ids(...values: string[]): (slug: string, attempt: number) => string {
  return (_slug, attempt) => values[attempt] ?? values.at(-1)!;
}

/** Plant a pending collision at the first publication commit point. */
function raceFirstAttempt(file: string) {
  return async (_id: string, attempt: number): Promise<void> => {
    if (attempt === 0) await writeFile(file, "raced-authority");
  };
}

describe("Final9 generic collision-exclusive publication", () => {
  it("preserves a pending collision and publishes the second identity", async () => {
    const existing = await plant("pending", COLLISION, "pending-authority");

    const created = await writeGeneric({ idForAttemptForTest: ids(COLLISION, SECOND) });

    expect(created.id).toBe(SECOND);
    expect(await readFile(existing, "utf8")).toContain("pending-authority");
  });

  it("preserves an archive-only collision and publishes the second identity", async () => {
    const archived = await plant("archive", COLLISION, "archive-authority");

    const created = await writeGeneric({ idForAttemptForTest: ids(COLLISION, SECOND) });

    expect(created.id).toBe(SECOND);
    expect(await readFile(archived, "utf8")).toContain("archive-authority");
  });

  it("loses a publish race without replacing the raced pending leaf", async () => {
    const raced = path.join(root.dir, ".llmwiki", "candidates", `${COLLISION}.json`);

    const created = await writeGeneric({
      idForAttemptForTest: ids(COLLISION, SECOND),
      beforePublishForTest: raceFirstAttempt(raced),
    });

    expect(created.id).toBe(SECOND);
    expect(await readFile(raced, "utf8")).toBe("raced-authority");
  });

  it("rechecks archive absence at the publication boundary", async () => {
    let archived = "";
    const created = await writeGeneric({
      idForAttemptForTest: ids(COLLISION, SECOND),
      beforePublishForTest: async (_id, attempt) => {
        if (attempt === 0) archived = await plant("archive", COLLISION, "raced-archive");
      },
    });

    expect(created.id).toBe(SECOND);
    expect(await readFile(archived, "utf8")).toContain("raced-archive");
    await expect(readFile(path.join(root.dir, ".llmwiki", "candidates", `${COLLISION}.json`)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails after 16 generic collisions without replacing authority", async () => {
    const existing = await plant("pending", COLLISION, "pending-authority");
    let attempts = 0;

    const writing = writeGeneric({
      idForAttemptForTest: () => { attempts += 1; return COLLISION; },
    });

    await expect(writing).rejects.toBeInstanceOf(FreshCandidateIdExhaustedError);
    expect(attempts).toBe(16);
    expect(await readFile(existing, "utf8")).toContain("pending-authority");
  });

  it("refuses canonical replacement when its custody changes before commit", async () => {
    const first = await writeCandidate(root.dir, draft("first"));
    const file = path.join(root.dir, ".llmwiki", "candidates", `${first.id}.json`);

    const replacing = (writeCandidate as GenericWriter)(root.dir, draft("second"), {
      beforePublishForTest: async () => { await writeFile(file, "raced-authority"); },
    });

    await expect(replacing).rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
    expect(await readFile(file, "utf8")).toBe("raced-authority");
  });

  it("refuses canonical replacement when archive also owns the identity", async () => {
    const first = await writeCandidate(root.dir, draft("first"));
    const pending = path.join(root.dir, ".llmwiki", "candidates", `${first.id}.json`);
    const archived = await plant("archive", first.id, "historical-authority");
    const before = await readFile(pending, "utf8");

    await expect(writeCandidate(root.dir, draft("second")))
      .rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
    expect(await readFile(pending, "utf8")).toBe(before);
    expect(await readFile(archived, "utf8")).toContain("historical-authority");
  });
});

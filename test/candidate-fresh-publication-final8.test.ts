/**
 * @file test/candidate-fresh-publication-final8.test.ts
 * @description Decision 17 regressions require fresh review candidates to use
 * collision-exclusive identities across pending and archive namespaces.
 */

import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FreshCandidateIdExhaustedError,
  writeFreshCandidate,
  type CandidateDraft,
} from "../src/compiler/candidates.js";
import { snapshotCandidateQueue } from "./fixtures/candidate-queue.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();
const COLLISION = "fresh-collision";
const SECOND = "fresh-second";

/** Minimal draft for collision-exclusive publication tests. */
function draft(): CandidateDraft {
  return { title: "Fresh", slug: "fresh", summary: "", sources: [], body: "new" };
}

/** Plant exact bytes in one candidate namespace. */
async function plant(location: "pending" | "archive", id: string, body: string): Promise<string> {
  const suffix = location === "pending" ? [] : ["archive"];
  const dir = path.join(root.dir, ".llmwiki", "candidates", ...suffix);
  const file = path.join(dir, `${id}.json`);
  await mkdir(dir, { recursive: true });
  await writeFile(file, body);
  return file;
}

/** Deterministic id sequence for one fresh-writer attempt series. */
function ids(...values: string[]): (slug: string, attempt: number) => string {
  return (_slug, attempt) => values[attempt] ?? values.at(-1)!;
}

describe("Final8 collision-exclusive candidate publication", () => {
  it("preserves a pending collision and retries with a distinct id", async () => {
    const existing = await plant("pending", COLLISION, "manual-authority");

    const created = await writeFreshCandidate(root.dir, draft(), {
      idForAttemptForTest: ids(COLLISION, SECOND),
    });

    expect(created.id).toBe(SECOND);
    expect(await readFile(existing, "utf8")).toBe("manual-authority");
    expect(Object.keys(await snapshotCandidateQueue(root.dir))).toHaveLength(2);
  });

  it("does not reuse an archived predecessor identity", async () => {
    const archived = await plant("archive", COLLISION, "archived-authority");

    const created = await writeFreshCandidate(root.dir, draft(), {
      idForAttemptForTest: ids(COLLISION, SECOND),
    });

    expect(created.id).toBe(SECOND);
    expect(await readFile(archived, "utf8")).toBe("archived-authority");
    expect(await snapshotCandidateQueue(root.dir)).toHaveProperty(`${SECOND}.json`);
  });

  it("treats an existing pending symlink as a collision", async () => {
    const candidates = path.join(root.dir, ".llmwiki", "candidates");
    const authority = path.join(root.dir, "manual-authority.txt");
    const collision = path.join(candidates, `${COLLISION}.json`);
    await mkdir(candidates, { recursive: true });
    await writeFile(authority, "manual-authority");
    await symlink(authority, collision);

    const created = await writeFreshCandidate(root.dir, draft(), {
      idForAttemptForTest: ids(COLLISION, SECOND),
    });

    expect(created.id).toBe(SECOND);
    expect((await lstat(collision)).isSymbolicLink()).toBe(true);
    expect(await readFile(authority, "utf8")).toBe("manual-authority");
  });

  it("loses a publish race without replacing the raced pending leaf", async () => {
    const raced = path.join(root.dir, ".llmwiki", "candidates", `${COLLISION}.json`);

    const created = await writeFreshCandidate(root.dir, draft(), {
      idForAttemptForTest: ids(COLLISION, SECOND),
      beforePublishForTest: async (_id, attempt) => {
        if (attempt === 0) await writeFile(raced, "raced-authority");
      },
    });

    expect(created.id).toBe(SECOND);
    expect(await readFile(raced, "utf8")).toBe("raced-authority");
  });

  it("treats post-link cleanup failure as committed publication", async () => {
    const created = await writeFreshCandidate(root.dir, draft(), {
      idForAttemptForTest: ids(SECOND),
      afterPublishForTest: async () => { throw new Error("cleanup failed"); },
    });
    const file = path.join(root.dir, ".llmwiki", "candidates", `${SECOND}.json`);

    expect(created.id).toBe(SECOND);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ id: SECOND });
  });

  it("fails after 16 collisions without mutating either namespace", async () => {
    await plant("pending", COLLISION, "pending-authority");
    await plant("archive", "archived-only", "archive-authority");
    const before = await snapshotCandidateQueue(root.dir);
    let attempts = 0;

    const writing = writeFreshCandidate(root.dir, draft(), {
      idForAttemptForTest: () => { attempts += 1; return COLLISION; },
    });

    await expect(writing).rejects.toBeInstanceOf(FreshCandidateIdExhaustedError);
    expect(attempts).toBe(16);
    expect(await snapshotCandidateQueue(root.dir)).toEqual(before);
  });
});

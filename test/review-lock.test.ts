/**
 * Tests that reviewApproveCommand and reviewRejectCommand acquire and release
 * the `.llmwiki/lock` around their mutating operations.
 *
 * True concurrency is non-deterministic in a single process, so these tests
 * verify lock discipline by mocking `acquireLock` / `releaseLock` and
 * asserting the expected call sequence. A sequential two-approval test also
 * confirms that when two candidates share a source, exactly one persists the
 * source state (the second approval, when no sibling remains).
 *
 * TOCTOU regression: the last two describe blocks simulate a candidate
 * disappearing between the pre-lock fast-fail read and the under-lock re-read.
 * They confirm the commands abort cleanly (exit code 1) and produce no output
 * artefacts (no wiki page, no archive file).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFile, realpath, unlink } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { writeCandidate } from "../src/compiler/candidates.js";
import {
  CANDIDATES_DIR,
  CANDIDATES_ARCHIVE_DIR,
  CONCEPTS_DIR,
  STATE_FILE,
} from "../src/utils/constants.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import type { ReviewCandidate, WikiState } from "../src/utils/types.js";

const SHARED_SOURCE = "shared-source.md";

/** Minimal valid page body referencing SHARED_SOURCE. */
function buildPageBody(title: string): string {
  return [
    "---",
    `title: ${title}`,
    `summary: "Summary for ${title}"`,
    "sources:",
    `  - "${SHARED_SOURCE}"`,
    'createdAt: "2026-01-01T00:00:00.000Z"',
    'updatedAt: "2026-01-01T00:00:00.000Z"',
    "tags: []",
    "aliases: []",
    "---",
    "",
    `Body for ${title}.`,
    "",
  ].join("\n");
}

/** Write a candidate referencing SHARED_SOURCE. */
async function writeSampleCandidate(
  root: string,
  title: string,
  slug: string,
  sourceStates?: ReviewCandidate["sourceStates"],
): Promise<ReviewCandidate> {
  return writeCandidate(root, {
    title,
    slug,
    summary: `${title} summary`,
    sources: [SHARED_SOURCE],
    body: buildPageBody(title),
    ...(sourceStates ? { sourceStates } : {}),
  });
}

/**
 * Stub acquireLock to return `granted` and releaseLock to resolve immediately.
 * Returns the spies so callers can assert call counts.
 */
async function stubLock(granted: boolean): Promise<{
  acquireSpy: ReturnType<typeof vi.spyOn>;
  releaseSpy: ReturnType<typeof vi.spyOn>;
}> {
  const lockMod = await import("../src/utils/lock.js");
  const acquireSpy = vi.spyOn(lockMod, "acquireLock").mockResolvedValue(granted);
  const releaseSpy = vi.spyOn(lockMod, "releaseLock").mockResolvedValue(undefined);
  return { acquireSpy, releaseSpy };
}

/**
 * Assert that the candidate file still exists in the pending area — confirming
 * no mutations ran when the lock was unavailable.
 */
function assertCandidatePending(root: string, candidateId: string): void {
  const candidateFile = path.join(root, CANDIDATES_DIR, `${candidateId}.json`);
  expect(existsSync(candidateFile)).toBe(true);
}

/**
 * Assert that acquireLock and releaseLock were each called exactly once with
 * the expected root path. Used to verify lock discipline for approve/reject.
 */
function assertLockUsed(
  acquireSpy: ReturnType<typeof vi.spyOn>,
  releaseSpy: ReturnType<typeof vi.spyOn>,
  root: string,
): void {
  expect(acquireSpy).toHaveBeenCalledTimes(1);
  expect(acquireSpy).toHaveBeenCalledWith(root);
  expect(releaseSpy).toHaveBeenCalledTimes(1);
  expect(releaseSpy).toHaveBeenCalledWith(root);
}

const root = useTempRoot(["sources"]);

/**
 * Resolved real path of the current temp dir.
 *
 * On macOS, /var/folders is a symlink to /private/var/folders.
 * process.cwd() returns the real path after chdir, so we normalise for
 * assertions about what path was passed to acquireLock/releaseLock.
 */
let rootReal: string;

beforeEach(async () => {
  rootReal = await realpath(root.dir);
  // useTempRoot already handles reset via afterEach
});

// vi.resetModules is needed here because we spy on the lock module via dynamic
// import. Without it, the mock leaks across tests in this file.
// useTempRoot's afterEach calls vi.restoreAllMocks; we add resetModules on top.
afterEach(() => {
  vi.resetModules();
});

describe("review approve — lock discipline", () => {
  it("acquires and releases the lock exactly once per approval", async () => {
    const { acquireSpy, releaseSpy } = await stubLock(true);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { default: reviewApproveCommand } = await import(
      "../src/commands/review-approve.js"
    );
    const candidate = await writeSampleCandidate(root.dir, "Alpha", "alpha");

    await reviewApproveCommand(candidate.id);

    assertLockUsed(acquireSpy, releaseSpy, rootReal);
  });

  it("sets exit code 1 and skips writes when lock is unavailable", async () => {
    await stubLock(false);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { default: reviewApproveCommand } = await import(
      "../src/commands/review-approve.js"
    );
    const candidate = await writeSampleCandidate(root.dir, "Beta", "beta");

    await reviewApproveCommand(candidate.id);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    assertCandidatePending(root.dir, candidate.id);
  });
});

describe("review reject — lock discipline", () => {
  it("acquires and releases the lock exactly once per rejection", async () => {
    const { acquireSpy, releaseSpy } = await stubLock(true);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { default: reviewRejectCommand } = await import(
      "../src/commands/review-reject.js"
    );
    const candidate = await writeSampleCandidate(root.dir, "Gamma", "gamma");

    await reviewRejectCommand(candidate.id);

    assertLockUsed(acquireSpy, releaseSpy, rootReal);
  });

  it("sets exit code 1 and leaves candidate pending when lock is unavailable", async () => {
    await stubLock(false);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { default: reviewRejectCommand } = await import(
      "../src/commands/review-reject.js"
    );
    const candidate = await writeSampleCandidate(root.dir, "Delta", "delta");

    await reviewRejectCommand(candidate.id);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    assertCandidatePending(root.dir, candidate.id);
  });
});

describe("sequential approvals — source-state persistence under lock", () => {
  /**
   * Two candidates from the same source approved in sequence (simulating what
   * concurrent approvals would serialize to under lock). Each approval immediately
   * union-adds its own slug — no deferral until last sibling. Both approvals must
   * result in a defined source-state entry with the correct hash.
   */
  it("persists source state immediately on each approval, accumulating both slugs", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { default: reviewApproveCommand } = await import(
      "../src/commands/review-approve.js"
    );

    const sourceStates = {
      [SHARED_SOURCE]: {
        hash: "abc123",
        concepts: ["alpha", "beta"],
        compiledAt: "2026-01-01T00:00:00.000Z",
      },
    };

    const alpha = await writeSampleCandidate(root.dir, "Alpha", "alpha", sourceStates);
    const beta = await writeSampleCandidate(root.dir, "Beta", "beta", sourceStates);

    // First approval: immediately union-adds alpha's slug to source state.
    await reviewApproveCommand(alpha.id);
    const stateAfterFirst = await readStateFile(root.dir);
    expect(stateAfterFirst?.sources[SHARED_SOURCE]).toBeDefined();
    expect(stateAfterFirst?.sources[SHARED_SOURCE].hash).toBe("abc123");
    expect(stateAfterFirst?.sources[SHARED_SOURCE].concepts).toContain("alpha");

    // Second approval: union-adds beta's slug — both alpha and beta are now recorded.
    await reviewApproveCommand(beta.id);
    const stateAfterSecond = await readStateFile(root.dir);
    expect(stateAfterSecond?.sources[SHARED_SOURCE]).toBeDefined();
    expect(stateAfterSecond?.sources[SHARED_SOURCE].hash).toBe("abc123");
    expect(stateAfterSecond?.sources[SHARED_SOURCE].concepts).toContain("alpha");
    expect(stateAfterSecond?.sources[SHARED_SOURCE].concepts).toContain("beta");
  });
});

/**
 * Stub acquireLock so that it deletes the given candidate file before
 * returning true, simulating a concurrent process that removed the candidate
 * between the pre-lock fast-fail read and the lock acquisition.
 */
async function stubLockWithCandidateRemoval(
  root: string,
  candidateId: string,
): Promise<void> {
  const lockMod = await import("../src/utils/lock.js");
  vi.spyOn(lockMod, "acquireLock").mockImplementation(async () => {
    const candidateFile = path.join(root, CANDIDATES_DIR, `${candidateId}.json`);
    await unlink(candidateFile);
    return true;
  });
  vi.spyOn(lockMod, "releaseLock").mockResolvedValue(undefined);
}

describe("approve TOCTOU — candidate removed between pre-lock check and under-lock read", () => {
  it("aborts with exit code 1 and does not write a wiki page", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const candidate = await writeSampleCandidate(root.dir, "Epsilon", "epsilon");
    await stubLockWithCandidateRemoval(root.dir, candidate.id);

    const { default: reviewApproveCommand } = await import(
      "../src/commands/review-approve.js"
    );
    await reviewApproveCommand(candidate.id);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    const wikiPage = path.join(root.dir, CONCEPTS_DIR, `${candidate.slug}.md`);
    expect(existsSync(wikiPage)).toBe(false);
  });
});

describe("reject TOCTOU — candidate removed between pre-lock check and under-lock read", () => {
  it("aborts with exit code 1 and does not write an archive file", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const candidate = await writeSampleCandidate(root.dir, "Zeta", "zeta");
    await stubLockWithCandidateRemoval(root.dir, candidate.id);

    const { default: reviewRejectCommand } = await import(
      "../src/commands/review-reject.js"
    );
    await reviewRejectCommand(candidate.id);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    const archiveFile = path.join(root.dir, CANDIDATES_ARCHIVE_DIR, `${candidate.id}.json`);
    expect(existsSync(archiveFile)).toBe(false);
  });
});

/** Read state.json, returning undefined if the file does not exist. */
async function readStateFile(root: string): Promise<WikiState | undefined> {
  const raw = await readFile(path.join(root, STATE_FILE), "utf-8").catch(() => "");
  return raw ? (JSON.parse(raw) as WikiState) : undefined;
}

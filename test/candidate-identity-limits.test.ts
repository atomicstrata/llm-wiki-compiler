/**
 * @file test/candidate-identity-limits.test.ts
 * @description Candidate filename limits preserve atomic-write headroom and
 * reject oversized slugs or legacy identifiers before store mutation.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  UnsafeCandidateIdError,
  writeCandidate,
  readCandidate,
  archiveCandidate,
} from "../src/compiler/candidates.js";
import {
  archivePath,
  candidatePath,
  MAX_CANDIDATE_ID_BYTES,
  MAX_CANDIDATE_SLUG_BYTES,
  MAX_WRITABLE_CANDIDATE_ID_BYTES,
} from "../src/compiler/candidate-paths.js";
import { CANDIDATES_DIR } from "../src/utils/constants.js";
import { snapshotCandidateQueue } from "./fixtures/candidate-queue.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();
const ATOMIC_TEMP_SUFFIX = `.${"a".repeat(16)}.tmp`;
const SECRET_SENTINEL = "SAFE_ASCII_LIMIT_SENTINEL";

/** Build the smallest complete candidate draft for one physical slug. */
function draftFor(slug: string) {
  return {
    title: "Candidate limit fixture",
    slug,
    summary: "",
    sources: [],
    body: "---\ntitle: Candidate limit fixture\n---\nBody\n",
  };
}

/** Plant one target-matching legacy record under an independently sized ID. */
async function plantLegacyCandidate(id: string): Promise<void> {
  const dir = path.join(root.dir, CANDIDATES_DIR);
  await mkdir(dir, { recursive: true });
  const candidate = {
    ...draftFor("legacy-over-cap"),
    id,
    generatedAt: "2026-01-01T00:00:00.000Z",
    reviewMode: "forced",
    heldReasons: [{ code: "manual-review-requested" }],
  };
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify(candidate));
}

/** Assert a draft refusal is typed and creates no candidate-store directory. */
async function expectDraftRefusal(slug: string): Promise<void> {
  await expect(writeCandidate(root.dir, draftFor(slug))).rejects.toBeInstanceOf(
    UnsafeCandidateIdError,
  );
  expect(existsSync(path.join(root.dir, CANDIDATES_DIR))).toBe(false);
}

describe("candidate physical identity ceilings", () => {
  it("derives the 229-byte id ceiling from the complete atomic component", () => {
    const extensionBytes = Buffer.byteLength(".json", "utf8");
    const tempSuffixBytes = Buffer.byteLength(ATOMIC_TEMP_SUFFIX, "utf8");

    expect(MAX_WRITABLE_CANDIDATE_ID_BYTES + extensionBytes + tempSuffixBytes).toBe(255);
    expect(MAX_CANDIDATE_SLUG_BYTES + 1 + 8).toBe(MAX_WRITABLE_CANDIDATE_ID_BYTES);
    expect(MAX_CANDIDATE_ID_BYTES + extensionBytes).toBe(255);
  });

  it.each([219, 220])("accepts a %i-byte ASCII draft slug", async (bytes) => {
    const created = await writeCandidate(root.dir, draftFor("a".repeat(bytes)));

    expect(Buffer.byteLength(created.slug, "utf8")).toBe(bytes);
    expect(Buffer.byteLength(created.id, "utf8")).toBe(bytes + 9);
  });

  it("rejects a 221-byte ASCII draft slug before store access", async () => {
    await expectDraftRefusal("a".repeat(221));
  });

  it("accepts and rejects exact multibyte slug boundaries", async () => {
    const accepted = "é".repeat(110);
    const rejected = `${accepted}a`;

    await expect(writeCandidate(root.dir, draftFor(accepted))).resolves.toMatchObject({ slug: accepted });
    await expect(writeCandidate(root.dir, draftFor(rejected))).rejects.toBeInstanceOf(UnsafeCandidateIdError);
  });

  it.each([228, 229, 230, 250])("accepts a direct %i-byte candidate id", async (bytes) => {
    const id = "a".repeat(bytes);

    await expect(candidatePath(root.dir, id)).resolves.toContain(`${id}.json`);
    await expect(archivePath(root.dir, id)).resolves.toContain(`${id}.json`);
  });

  it("rejects a physically impossible 251-byte candidate id before path resolution", async () => {
    const id = "a".repeat(251);

    await expect(candidatePath(root.dir, id)).rejects.toBeInstanceOf(UnsafeCandidateIdError);
    await expect(archivePath(root.dir, id)).rejects.toBeInstanceOf(UnsafeCandidateIdError);
    expect(existsSync(path.join(root.dir, CANDIDATES_DIR))).toBe(false);
  });

  it("accepts and rejects exact multibyte id boundaries", async () => {
    const accepted = "é".repeat(125);
    const rejected = `${accepted}a`;

    await expect(candidatePath(root.dir, accepted)).resolves.toContain(`${accepted}.json`);
    await expect(candidatePath(root.dir, rejected)).rejects.toBeInstanceOf(UnsafeCandidateIdError);
  });

  it("rejects a huge safe-ASCII slug without reflecting or creating the store", async () => {
    const slug = `${"a".repeat(10_000)}${SECRET_SENTINEL}`;
    let caught: unknown;

    try { await writeCandidate(root.dir, draftFor(slug)); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(UnsafeCandidateIdError);
    expect((caught as Error).message).not.toContain(SECRET_SENTINEL);
    expect(existsSync(path.join(root.dir, CANDIDATES_DIR))).toBe(false);
  });

  it("does not atomically replace a legacy record without temporary-file headroom", async () => {
    const id = "a".repeat(230);
    await plantLegacyCandidate(id);
    const before = await snapshotCandidateQueue(root.dir);

    await expect(writeCandidate(root.dir, draftFor("legacy-over-cap")))
      .rejects.toBeInstanceOf(UnsafeCandidateIdError);

    expect(await snapshotCandidateQueue(root.dir)).toEqual(before);
  });

  it("reads and archives a valid legacy filename without needing write-temp headroom", async () => {
    const id = "a".repeat(250);
    await plantLegacyCandidate(id);
    expect((await readCandidate(root.dir, id))?.id).toBe(id);
    expect(await archiveCandidate(root.dir, id)).toBe(true);
    expect(existsSync(await candidatePath(root.dir, id))).toBe(false);
    expect(existsSync(await archivePath(root.dir, id))).toBe(true);
  });
});

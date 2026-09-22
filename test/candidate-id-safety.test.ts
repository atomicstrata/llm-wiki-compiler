/**
 * @file test/candidate-id-safety.test.ts
 * @description Path-traversal hardening for candidate ids/slugs (FIX #2).
 *
 * `writeCandidate` builds a candidate id as `${slug}-${hex}` and the path
 * helpers join that id straight into `.llmwiki/candidates/`. A traversal-bearing
 * slug (`../evil`) would make the id a path-escape string. These tests pin that:
 *  - `writeCandidate` REFUSES an unsafe slug (typed error, nothing written);
 *  - a normal safe candidate still round-trips identically (byte-for-byte body);
 *  - no file is ever written outside the candidates dir.
 */

import { describe, it, expect } from "vitest";
import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import {
  writeCandidate,
  writeFreshCandidate,
  readCandidate,
  UnsafeCandidateIdError,
} from "../src/compiler/candidates.js";
import { CANDIDATES_DIR } from "../src/utils/constants.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

const BODY = "---\ntitle: Safe\n---\n\nBody.\n";
const LEGACY_BUNDLE_ID = "bnd_01J00000000000000000000000";
const NORMAL_CANDIDATE_ID = "legacy-bundle-collision-aaaa0001";
const ERROR_MESSAGE_LIMIT_BYTES = 512;
const SECRET_SENTINEL = "CANDIDATE_SECRET_SENTINEL";

/** A safe candidate draft for `slug` with a fixed body. */
function draftFor(slug: string) {
  return { title: slug, slug, summary: "", sources: [], body: BODY };
}

/** Plant one candidate with controlled identity and sort order. */
async function plantCandidate(
  id: string,
  generatedAt: string,
  fileId = id,
): Promise<void> {
  const candidatesDir = path.join(root.dir, CANDIDATES_DIR);
  await mkdir(candidatesDir, { recursive: true });
  await writeFile(path.join(candidatesDir, `${fileId}.json`), JSON.stringify({
    ...draftFor("legacy-bundle-collision"),
    id,
    generatedAt,
    reviewMode: "forced",
    heldReasons: [{ code: "manual-review-requested" }],
  }));
}

/** Snapshot every pending candidate file as exact base64-encoded bytes. */
async function snapshotCandidateFiles(): Promise<Record<string, string>> {
  const candidatesDir = path.join(root.dir, CANDIDATES_DIR);
  const names = (await readdir(candidatesDir)).filter((name) => name.endsWith(".json")).sort();
  const entries = await Promise.all(names.map(async (name) => {
    const bytes = await readFile(path.join(candidatesDir, name));
    return [name, bytes.toString("base64")] as const;
  }));
  return Object.fromEntries(entries);
}

/** Assert a reserved matching id aborts without mutating legacy bytes. */
async function expectReservedMatchRefusedWithoutMutation(
  expectedCandidateId = LEGACY_BUNDLE_ID,
  fileId = LEGACY_BUNDLE_ID,
): Promise<void> {
  const before = await snapshotCandidateFiles();
  await expect(
    writeCandidate(root.dir, draftFor("legacy-bundle-collision")),
  ).rejects.toBeInstanceOf(UnsafeCandidateIdError);
  expect(await snapshotCandidateFiles()).toEqual(before);
  expect(await readCandidate(root.dir, fileId)).toMatchObject({
    id: expectedCandidateId,
    slug: "legacy-bundle-collision",
  });
}

/** Assert one unsafe identity refusal is bounded and never reflects hostile text. */
async function expectNonreflectingUnsafe(action: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(UnsafeCandidateIdError);
  const message = (caught as Error).message;
  expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(ERROR_MESSAGE_LIMIT_BYTES);
  expect(message).not.toContain(SECRET_SENTINEL);
  expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u);
}

describe("candidate id/slug path-traversal safety", () => {
  it("refuses an unsafe traversal slug and writes nothing", async () => {
    await expect(writeCandidate(root.dir, draftFor("../evil"))).rejects.toBeInstanceOf(
      UnsafeCandidateIdError,
    );
    const dir = path.join(root.dir, CANDIDATES_DIR);
    const files = existsSync(dir) ? await readdir(dir) : [];
    expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });

  it("refuses a slug containing a path separator and writes nothing", async () => {
    await expect(writeCandidate(root.dir, draftFor("nested/evil"))).rejects.toBeInstanceOf(
      UnsafeCandidateIdError,
    );
    expect(existsSync(path.join(root.dir, "nested"))).toBe(false);
  });

  it("does not escape the candidates dir for a deep traversal slug", async () => {
    await expect(
      writeCandidate(root.dir, draftFor("../../outside")),
    ).rejects.toBeInstanceOf(UnsafeCandidateIdError);
    expect(existsSync(path.join(path.dirname(root.dir), "outside.json"))).toBe(false);
  });

  it("round-trips a normal safe candidate identically", async () => {
    const created = await writeCandidate(root.dir, draftFor("attention-rag"));
    expect(created.id).toMatch(/^attention-rag-[0-9a-f]{8}$/);
    const loaded = await readCandidate(root.dir, created.id);
    expect(loaded?.body).toBe(BODY);
    const file = path.join(root.dir, CANDIDATES_DIR, `${created.id}.json`);
    expect(JSON.parse(await readFile(file, "utf8")).slug).toBe("attention-rag");
  });

  it("rejects a generated bnd_ id before candidate-store access", async () => {
    const candidatesPath = path.join(root.dir, CANDIDATES_DIR);
    await mkdir(path.dirname(candidatesPath), { recursive: true });
    await writeFile(candidatesPath, "store access must not occur");

    await expect(writeCandidate(root.dir, draftFor("bnd_new-candidate"))).rejects.toBeInstanceOf(
      UnsafeCandidateIdError,
    );
    expect(await readFile(candidatesPath, "utf8")).toBe("store access must not occur");
  });

  it("refuses a reserved canonical duplicate without changing any file", async () => {
    await plantCandidate(LEGACY_BUNDLE_ID, "2026-01-01T00:00:00.000Z");
    await plantCandidate(NORMAL_CANDIDATE_ID, "2026-01-02T00:00:00.000Z");

    await expectReservedMatchRefusedWithoutMutation();
  });

  it("refuses a reserved extra duplicate without deleting any file", async () => {
    await plantCandidate(NORMAL_CANDIDATE_ID, "2026-01-01T00:00:00.000Z");
    await plantCandidate(LEGACY_BUNDLE_ID, "2026-01-02T00:00:00.000Z");

    await expectReservedMatchRefusedWithoutMutation();
  });

  it("refuses an ASCII-case alias before writing or deleting candidates", async () => {
    const uppercaseId = LEGACY_BUNDLE_ID.toUpperCase();
    await plantCandidate(uppercaseId, "2026-01-01T00:00:00.000Z", LEGACY_BUNDLE_ID);
    await plantCandidate(NORMAL_CANDIDATE_ID, "2026-01-02T00:00:00.000Z");

    await expectReservedMatchRefusedWithoutMutation(uppercaseId);
  });

  it("refuses a reserved filename with a non-reserved embedded id", async () => {
    const reservedFileId = LEGACY_BUNDLE_ID.toUpperCase();
    await plantCandidate(NORMAL_CANDIDATE_ID, "2026-01-01T00:00:00.000Z", reservedFileId);

    await expectReservedMatchRefusedWithoutMutation(NORMAL_CANDIDATE_ID, reservedFileId);
  });

  it("refuses a non-reserved filename with a reserved embedded id", async () => {
    const fileId = "legacy-mismatch-aaaa0002";
    const reservedRecordId = LEGACY_BUNDLE_ID.toUpperCase();
    await plantCandidate(reservedRecordId, "2026-01-01T00:00:00.000Z", fileId);

    await expectReservedMatchRefusedWithoutMutation(reservedRecordId, fileId);
  });

  it("does not let an unrelated reserved legacy filename block a write", async () => {
    await plantCandidate(NORMAL_CANDIDATE_ID, "2026-01-01T00:00:00.000Z", LEGACY_BUNDLE_ID);
    const legacyFile = path.join(root.dir, CANDIDATES_DIR, `${LEGACY_BUNDLE_ID}.json`);
    const before = await readFile(legacyFile);

    const created = await writeCandidate(root.dir, draftFor("ordinary-candidate"));

    expect(created.id).toMatch(/^ordinary-candidate-[0-9a-f]{8}$/);
    expect(await readFile(legacyFile)).toEqual(before);
  });

  it("refuses a target-matching mismatch whose embedded destination is absent", async () => {
    const fileId = "legacy-mismatch-aaaa0002";
    const recordId = "legacy-record-bbbb0002";
    await plantCandidate(recordId, "2026-01-01T00:00:00.000Z", fileId);
    const before = await snapshotCandidateFiles();
    let caught: unknown;

    try {
      await writeCandidate(root.dir, draftFor("legacy-bundle-collision"));
    } catch (error) {
      caught = error;
    }

    expect(await snapshotCandidateFiles()).toEqual(before);
    expect(caught).toMatchObject({ name: "CandidateIdentityMismatchError" });
    expect(existsSync(path.join(root.dir, CANDIDATES_DIR, `${recordId}.json`))).toBe(false);
  });

  it("reserves every ASCII case variant in the fresh candidate writer", async () => {
    for (const slug of ["bnd_fresh-candidate", "BND_fresh-candidate"]) {
      await expect(
        writeFreshCandidate(root.dir, draftFor(slug)),
      ).rejects.toBeInstanceOf(UnsafeCandidateIdError);
    }
  });

  it("does not reflect an oversized hostile draft slug", async () => {
    const hostile = `../${"x".repeat(10_000)}\u0000\u0085\u2028\u2029\u202e${SECRET_SENTINEL}`;

    await expectNonreflectingUnsafe(() => writeCandidate(root.dir, draftFor(hostile)));

    const dir = path.join(root.dir, CANDIDATES_DIR);
    expect(existsSync(dir) ? await readdir(dir) : []).toHaveLength(0);
  });

  it("does not reflect an oversized reserved embedded id", async () => {
    const hostile = `bnd_${"x".repeat(10_000)}\u0000\u0085\u2028\u2029\u202e${SECRET_SENTINEL}`;
    await plantCandidate(hostile, "2026-01-01T00:00:00.000Z", "selected-file");
    const before = await snapshotCandidateFiles();

    await expectNonreflectingUnsafe(
      () => writeCandidate(root.dir, draftFor("legacy-bundle-collision")),
    );

    expect(await snapshotCandidateFiles()).toEqual(before);
  });
});

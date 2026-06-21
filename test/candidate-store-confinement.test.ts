/**
 * @file test/candidate-store-confinement.test.ts
 * @description Fail-closed coverage for candidate-store directory confinement
 * (Phase-3 hardening, FIX #1).
 *
 * Before this guard, `resolveCandidatePath` validated only the candidate id and a
 * LEXICAL prefix — it never REALPATH-confined the candidates directory. So a
 * symlinked `.llmwiki/candidates -> /tmp/outside` made `writeCandidate` (and
 * read/delete/archive/list) operate OUTSIDE the project root.
 *
 * The store now resolves every candidate path through `confineUnderRoot`, which
 * realpath-confines the nearest existing ancestor under root, and lists/scans the
 * candidates directory only after a realpath dir check that fails CLOSED on an
 * existing-but-escaping symlink (absent dir → empty, never a write through it).
 *
 * These tests mirror `test/trust-journal-confinement.test.ts`: a symlinked
 * candidates dir refuses every operation and leaves the out-of-tree dir empty,
 * while a NORMAL candidates dir still round-trips a candidate identically.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  writeCandidate,
  readCandidate,
  deleteCandidate,
  archiveCandidate,
  listCandidates,
} from "../src/compiler/candidates.js";
import { UnsafeCandidateDirError } from "../src/compiler/candidate-store-paths.js";
import { LLMWIKI_DIR } from "../src/utils/constants.js";

let root = "";
let outside = "";

const BODY = "---\ntitle: Safe\n---\n\nBody.\n";

/** A safe candidate draft for `slug` with a fixed body. */
function draftFor(slug: string) {
  return { title: slug, slug, summary: "", sources: [], body: BODY };
}

/** Make `.llmwiki/candidates` a SYMLINK to the out-of-tree `outside` dir. */
async function symlinkCandidatesOutside(): Promise<void> {
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  await symlink(outside, path.join(root, LLMWIKI_DIR, "candidates"), "dir");
}

/** Names of entries currently in the out-of-tree dir. */
async function outsideEntries(): Promise<string[]> {
  return readdir(outside);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "candidate-confine-"));
  outside = await mkdtemp(path.join(os.tmpdir(), "candidate-outside-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  if (outside) await rm(outside, { recursive: true, force: true });
  root = outside = "";
});

describe("candidate store — symlinked candidates dir (filesystem tampering)", () => {
  it("writeCandidate REFUSES and creates nothing outside root", async () => {
    await symlinkCandidatesOutside();
    await expect(writeCandidate(root, draftFor("safe"))).rejects.toBeInstanceOf(UnsafeCandidateDirError);
    expect(await outsideEntries()).toHaveLength(0);
  });

  it("readCandidate over the symlinked dir fails closed, leaving outside untouched", async () => {
    await writeFile(path.join(outside, "planted.json"), "{}", "utf8");
    await symlinkCandidatesOutside();
    await expect(readCandidate(root, "planted")).rejects.toBeInstanceOf(UnsafeCandidateDirError);
    expect(await outsideEntries()).toEqual(["planted.json"]);
  });

  it("deleteCandidate over the symlinked dir fails closed, leaving outside untouched", async () => {
    await writeFile(path.join(outside, "victim.json"), "{}", "utf8");
    await symlinkCandidatesOutside();
    await expect(deleteCandidate(root, "victim")).rejects.toBeInstanceOf(UnsafeCandidateDirError);
    expect(await outsideEntries()).toEqual(["victim.json"]);
  });

  it("archiveCandidate over the symlinked dir fails closed, leaving outside untouched", async () => {
    await writeFile(path.join(outside, "victim.json"), "{}", "utf8");
    await symlinkCandidatesOutside();
    await expect(archiveCandidate(root, "victim")).rejects.toBeInstanceOf(UnsafeCandidateDirError);
    expect(await outsideEntries()).toEqual(["victim.json"]);
  });

  it("listCandidates over the symlinked dir fails closed, never reading through it", async () => {
    await writeFile(path.join(outside, "leak.json"), "{}", "utf8");
    await symlinkCandidatesOutside();
    await expect(listCandidates(root)).rejects.toBeInstanceOf(UnsafeCandidateDirError);
    expect(await outsideEntries()).toEqual(["leak.json"]);
  });
});

describe("candidate store — normal dir regression", () => {
  it("round-trips a candidate identically through a REAL candidates dir", async () => {
    const created = await writeCandidate(root, draftFor("attention-rag"));
    expect(created.id).toMatch(/^attention-rag-[0-9a-f]{8}$/);
    const loaded = await readCandidate(root, created.id);
    expect(loaded?.body).toBe(BODY);
    expect(await listCandidates(root)).toHaveLength(1);
  });
});

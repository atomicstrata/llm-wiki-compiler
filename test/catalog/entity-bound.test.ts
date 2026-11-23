/**
 * @file test/catalog/entity-bound.test.ts
 * @description The BOUNDED entity page read (`collectOne` with an
 * `EntityPageBound`, the batch compile's): on ordinary pages (valid,
 * field-violating, without an identity) it projects exactly what the
 * incumbent read projects; a page over the cap, and a page that grows after
 * its read (past the cap or not), are handed to the bound's refusal AFTER the
 * collector returns instead of being silently left out; without a bound the
 * incumbent read is unchanged and still reads the oversized page.
 */

import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { collectOne, type EntityPageBound, type EntityReadObservation } from "../../src/catalog/entity-rows.js";
import { loadNonDefaultProfile } from "../../src/profile/block.js";
import type { LoadedProfile } from "../../src/profile/types.js";
import { SAMPLE_PROFILE, writeMarkdownPage, writeProfileFile } from "../fixtures/profile-fixtures.js";

/** A small cap, so the boundary is reached with small files. */
const CAP = 4096;

/** What a test bound refused with. */
class Refused extends Error {
  constructor(readonly observed: EntityReadObservation) { super(observed.kind); }
}

/** A bound of {@link CAP} bytes recording its refusal, with optional read seams. */
const boundOf = (readOptionsForTest?: EntityPageBound["readOptionsForTest"]): EntityPageBound => ({
  maxBytes: CAP, refuse: (observed) => { throw new Refused(observed); }, ...(readOptionsForTest === undefined ? {} : { readOptionsForTest }),
});

let root: string;
let loaded: LoadedProfile;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "llmwiki-entity-bound-"));
  await writeProfileFile(root, SAMPLE_PROFILE);
  loaded = (await loadNonDefaultProfile(root))!;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** A page of exactly `bytes` bytes with a valid identity. */
const pageOf = (bytes: number): string => {
  const head = "---\ntitle: Sized\n---\n";
  return head + "x".repeat(bytes - head.length);
};

describe("a bounded entity read of ordinary pages", () => {
  it("projects exactly what the incumbent read projects", async () => {
    await writeMarkdownPage(root, "wiki/notes", "alpha", "---\ntitle: Alpha\n---\nA.");
    await writeMarkdownPage(root, "wiki/notes", "typed", "---\ntitle: 42\n---\nField violation.");
    await writeMarkdownPage(root, "wiki/notes", "untitled", "---\nslug: untitled\n---\nNo title.");
    await writeMarkdownPage(root, "wiki/notes", "edge", pageOf(CAP));
    for (const name of ["alpha.md", "typed.md", "untitled.md", "edge.md"]) {
      expect(await collectOne(root, loaded, "notes", name, boundOf())).toEqual(await collectOne(root, loaded, "notes", name));
    }
  });
});

describe("a bounded entity read of a page it cannot hold", () => {
  it("refuses a page over the cap after the collector returns, which the incumbent read still reads", async () => {
    await writeMarkdownPage(root, "wiki/notes", "huge", pageOf(CAP + 1));
    await expect(collectOne(root, loaded, "notes", "huge.md", boundOf())).rejects.toMatchObject({ observed: { kind: "oversize", bytes: CAP + 1 } });
    expect((await collectOne(root, loaded, "notes", "huge.md")).page?.title).toBe("Sized");
  });

  it("refuses a page that grows past the cap after its read", async () => {
    await writeMarkdownPage(root, "wiki/notes", "grows", pageOf(CAP - 8));
    const grow = async (): Promise<void> => { await appendFile(path.join(root, "wiki", "notes", "grows.md"), "y".repeat(64)); };
    await expect(collectOne(root, loaded, "notes", "grows.md", boundOf({ beforePostReadCheckForTest: grow }))).rejects.toMatchObject({ observed: { kind: "oversize" } });
  });

  it("refuses a page that changes within the cap after its read, never dropping it", async () => {
    await writeMarkdownPage(root, "wiki/notes", "edits", pageOf(CAP - 64));
    const edit = async (): Promise<void> => { await appendFile(path.join(root, "wiki", "notes", "edits.md"), "y".repeat(8)); };
    await expect(collectOne(root, loaded, "notes", "edits.md", boundOf({ beforePostReadCheckForTest: edit }))).rejects.toMatchObject({ observed: { kind: "unreadable" } });
  });
});

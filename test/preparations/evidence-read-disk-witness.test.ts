/**
 * @file test/preparations/evidence-read-disk-witness.test.ts
 * @description A BEFORE-AND-AFTER WITNESS for the preparation evidence reads on
 * the real local disk. It calls only ROOT FORMS that exist before and after the
 * reads are bound to their own leaf: `readPreparationEvidence`,
 * `readPreparationEvidenceBytes` and `writePreparationEvidenceCreateOnly`. The
 * same bytes of this file run on both sides of that change and must give the
 * same answers.
 *
 * IT IS DELIBERATELY SMALL. It holds only what no existing disk test asserts:
 * the byte form behind a second hard link; a symbolic link at the leaf itself;
 * an invalid digest rejecting in both forms, and before the location is looked
 * at; an unsafe location rejecting through the readers; and a writer's
 * collision over corrupted bytes. Everything else on disk is already pinned by
 * `evidence-store.test.ts`, `evidence-read-bytes.test.ts` and
 * `store-confinement.test.ts`, which run before and after as well.
 *
 * WHAT IT DOES NOT PIN. It races nothing, so it is not evidence about a leaf
 * swapped during a read. It cannot see handle closure. It creates no large
 * object, so it says nothing about the 2 GiB bound. The link cases need POSIX
 * links and it makes no claim elsewhere.
 *
 * EVERY DIRECTORY HERE is created by the shared temp-root tracker and removed
 * by it after each case. No path is ever handed to it for removal.
 */

import { createHash } from "node:crypto";
import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  readPreparationEvidence, readPreparationEvidenceBytes, writePreparationEvidenceCreateOnly,
} from "../../src/preparations/evidence-store.js";
import type { PreparationId } from "../../src/preparations/ids.js";
import { preparationPaths } from "../../src/preparations/paths.js";
import { PreparationIdentityError } from "../../src/preparations/problems.js";
import { tempRootTracker } from "../temp-roots.js";

const OWN_PREFIX = "preparation-evidence-read-witness-";
const SPACE = "research";
const UNIT = `prp_${"d".repeat(32)}` as PreparationId;
const AT = { workspaceId: SPACE, preparationId: UNIT };
const SOME_NAME = "f".repeat(64);
const CAP = 4096;
const DIGEST_WORDS = "preparation evidence digest must be lowercase SHA-256";
const UNAVAILABLE = { status: "unavailable" };

const roots = tempRootTracker();
afterEach(() => roots.cleanup());

/** A new project root whose evidence directory for {@link UNIT} exists and is empty. */
async function rootWithEvidenceDirectory(): Promise<string> {
  const root = await roots.create(OWN_PREFIX);
  await mkdir(preparationPaths(root, SPACE).evidenceRoot(UNIT), { recursive: true });
  return root;
}

describe("evidence reads on the local disk: a leaf that is not one plain, singly linked file", () => {
  it("E1 the byte form refuses a leaf that is a second hard link to another file", async () => {
    const root = await rootWithEvidenceDirectory();
    await writeFile(path.join(root, "elsewhere"), "planted");
    await link(path.join(root, "elsewhere"), preparationPaths(root, SPACE).evidenceFile(UNIT, SOME_NAME));
    expect(await readPreparationEvidenceBytes(root, AT, SOME_NAME, CAP)).toEqual(UNAVAILABLE);
  });

  it("E2 both forms refuse a symbolic link at the leaf itself, and do not follow it", async () => {
    const root = await rootWithEvidenceDirectory();
    await writeFile(path.join(root, "elsewhere"), "planted");
    await symlink(path.join(root, "elsewhere"), preparationPaths(root, SPACE).evidenceFile(UNIT, SOME_NAME));
    expect(await readPreparationEvidence(root, AT, SOME_NAME)).toEqual(UNAVAILABLE);
    expect(await readPreparationEvidenceBytes(root, AT, SOME_NAME, CAP)).toEqual(UNAVAILABLE);
  });
});

describe("evidence reads on the local disk: identities that are refused before any read", () => {
  it("E3 a digest that is not 64 lowercase hex characters rejects in both forms", async () => {
    const root = await rootWithEvidenceDirectory();
    for (const digest of [SOME_NAME.toUpperCase(), SOME_NAME.slice(1), `sha256:${SOME_NAME}`]) {
      await expect(readPreparationEvidence(root, AT, digest)).rejects.toThrow(DIGEST_WORDS);
      await expect(readPreparationEvidenceBytes(root, AT, digest, CAP)).rejects.toThrow(DIGEST_WORDS);
    }
  });

  it("E4 an unsafe workspace rejects through both readers as an identity error", async () => {
    const root = await rootWithEvidenceDirectory();
    const unsafe = { workspaceId: "../escape", preparationId: UNIT };
    await expect(readPreparationEvidence(root, unsafe, SOME_NAME)).rejects.toBeInstanceOf(PreparationIdentityError);
    await expect(readPreparationEvidenceBytes(root, unsafe, SOME_NAME, CAP)).rejects.toBeInstanceOf(PreparationIdentityError);
  });

  it("E5 the digest is checked first: an invalid digest at an unsafe workspace rejects in the digest's words", async () => {
    const root = await rootWithEvidenceDirectory();
    const unsafe = { workspaceId: "../escape", preparationId: UNIT };
    await expect(readPreparationEvidence(root, unsafe, "not-a-digest")).rejects.toThrow(DIGEST_WORDS);
    await expect(readPreparationEvidenceBytes(root, unsafe, "not-a-digest", CAP)).rejects.toThrow(DIGEST_WORDS);
  });
});

describe("evidence writes on the local disk: a collision reaches the reader", () => {
  it("E6 writing the same bytes over a leaf that was corrupted in place is a conflict, in the reader's word", async () => {
    const root = await roots.create(OWN_PREFIX);
    const bytes = Buffer.from("the original evidence body");
    const name = createHash("sha256").update(bytes).digest("hex");
    expect(await writePreparationEvidenceCreateOnly(root, AT, bytes)).toBe("created");
    await writeFile(preparationPaths(root, SPACE).evidenceFile(UNIT, name), Buffer.alloc(bytes.byteLength, 0x7a));
    await expect(writePreparationEvidenceCreateOnly(root, AT, bytes)).rejects.toThrow("preparation evidence conflict: mismatch");
  });
});

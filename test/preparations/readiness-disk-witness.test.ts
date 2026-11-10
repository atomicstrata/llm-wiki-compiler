/**
 * @file test/preparations/readiness-disk-witness.test.ts
 * @description A BEFORE-AND-AFTER WITNESS for preparation service readiness on
 * the real local disk. It calls only the four ROOT FORMS, which exist before
 * and after readiness is bound to its own reads: `resolveHostReadiness`,
 * `resolvePreparationReadReadiness`, `preparationResetPreflightRefusal` and
 * `preparationPreflightRefusal`. The same bytes of this file run on both sides
 * of that change and must give the same answers.
 *
 * WHAT IT PINS. For a handful of real project states it asserts the WHOLE
 * answer of all four forms, words included: no store; a healthy store with and
 * without a key; a file where the store should be; a profile that will not
 * load; a key the reader refuses; and a store whose parent cannot be searched.
 * Before this file no test asserted the write path's refusal words, the key
 * refusal's words, or the could-not-tell arm on disk.
 *
 * THE COULD-NOT-TELL CASE removes search permission from the project root for
 * the length of one case and restores it in a `finally`. It cannot hold for a
 * process that ignores permission bits, so it is skipped when the effective
 * user id is 0. It needs POSIX permissions and makes no claim elsewhere.
 *
 * WHAT IT DOES NOT PIN. For a file where the store should be, it asserts only
 * the read form, whose answer is settled by the store look alone. It races
 * nothing. Readiness says whether a project can be acted in; it is not an
 * authority check and this file is not evidence of one. The key bytes here are
 * a fixed test pattern, never a real key.
 *
 * EVERY DIRECTORY HERE is created by the shared temp-root tracker and removed
 * by it after each case. No path is ever handed to it for removal.
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { preparationKeyFile } from "../../src/preparations/paths.js";
import {
  preparationPreflightRefusal, preparationResetPreflightRefusal, resolveHostReadiness,
  resolvePreparationReadReadiness,
} from "../../src/preparations/service-readiness.js";
import { LLMWIKI_DIR, PROFILE_FILE } from "../../src/utils/constants.js";
import { tempRootTracker } from "../temp-roots.js";

const OWN_PREFIX = "preparation-readiness-witness-";
const KEY_BYTES = 32;
const OWNER_ONLY = 0o600;
const GROUP_READABLE = 0o640;
const NO_ACCESS = 0o000;
const OWNER_ALL = 0o700;
/** A fixed test pattern. Not a real key. */
const KEY_TEXT = Buffer.alloc(KEY_BYTES, 6).toString("base64");
const STORE_MISSING = "no .llmwiki store here; run from the project root";
const SECOND_STORE = "no .llmwiki store here; run from the project root rather than creating a second store";
const PROFILE_BROKEN = "the project profile is present but unreadable; preparation commands cannot proceed";
const KEY_UNREADABLE = "the preparation key is unreadable; preparation commands cannot proceed";
const READY = { ready: true, reason: null };
const ALL_READY = { host: READY, read: { status: "ready" }, reset: null, preflight: null };
const runsAsSuperuser = typeof process.getuid === "function" && process.getuid() === 0;

const roots = tempRootTracker();
afterEach(() => roots.cleanup());

/** A new project root with an empty store directory. */
async function rootWithStore(): Promise<string> {
  const root = await roots.create(OWN_PREFIX);
  await mkdir(path.join(root, LLMWIKI_DIR));
  return root;
}

/** Write the store's key leaf with `mode`, holding the canonical text of the test pattern. */
async function writeKeyLeaf(root: string, mode: number): Promise<void> {
  await writeFile(preparationKeyFile(root), KEY_TEXT);
  await chmod(preparationKeyFile(root), mode);
}

/** The whole answer of all four root forms for one project root. */
async function allForms(root: string): Promise<Record<"host" | "read" | "reset" | "preflight", unknown>> {
  return {
    host: await resolveHostReadiness(root),
    read: await resolvePreparationReadReadiness(root),
    reset: await preparationResetPreflightRefusal(root),
    preflight: await preparationPreflightRefusal(root),
  };
}

describe("readiness on the local disk: a project that can be acted in", () => {
  it("R1 a store with no profile and no key is ready in every form: an absent key does not refuse", async () => {
    expect(await allForms(await rootWithStore())).toEqual(ALL_READY);
  });

  it("R2 a store with a healthy key is ready in every form", async () => {
    const root = await rootWithStore();
    await writeKeyLeaf(root, OWNER_ONLY);
    expect(await allForms(root)).toEqual(ALL_READY);
  });
});

describe("readiness on the local disk: no store here", () => {
  it("R3 a directory with no store is absent to a read and refused to both write forms, each in its own words", async () => {
    expect(await allForms(await roots.create(OWN_PREFIX))).toEqual({
      host: READY, read: { status: "absent", detail: STORE_MISSING }, reset: SECOND_STORE, preflight: SECOND_STORE,
    });
  });

  it("R4 a file where the store should be is absent to a read, in different words", async () => {
    const root = await roots.create(OWN_PREFIX);
    await writeFile(path.join(root, LLMWIKI_DIR), "not a directory");
    expect(await resolvePreparationReadReadiness(root))
      .toEqual({ status: "absent", detail: `${LLMWIKI_DIR} exists here but is not a directory` });
  });
});

describe("readiness on the local disk: a store that is here and cannot be acted in", () => {
  it("R5 a profile that will not load refuses every form in the profile's words; to a read it is unreadable, never absent", async () => {
    const root = await rootWithStore();
    await writeFile(path.join(root, PROFILE_FILE), "{ not json");
    expect(await allForms(root)).toEqual({
      host: { ready: false, reason: PROFILE_BROKEN }, read: { status: "unreadable", detail: PROFILE_BROKEN },
      reset: PROFILE_BROKEN, preflight: PROFILE_BROKEN,
    });
  });

  it("R6 a key the reader refuses stops everything except a reset, which passes its preflight", async () => {
    const root = await rootWithStore();
    await writeKeyLeaf(root, GROUP_READABLE);
    expect(await allForms(root)).toEqual({
      host: { ready: false, reason: KEY_UNREADABLE }, read: { status: "unreadable", detail: KEY_UNREADABLE },
      reset: null, preflight: KEY_UNREADABLE,
    });
  });
});

describe("readiness on the local disk: a store this process cannot look at", () => {
  it.skipIf(runsAsSuperuser)("R7 an unsearchable project root is could-not-tell to a read, naming the code, and one collapsed refusal to a write", async () => {
    const root = await rootWithStore();
    await chmod(root, NO_ACCESS);
    try {
      expect(await resolvePreparationReadReadiness(root))
        .toEqual({ status: "unreadable", detail: "the .llmwiki store could not be read (EACCES)" });
      expect(await preparationPreflightRefusal(root)).toBe(SECOND_STORE);
      expect(await preparationResetPreflightRefusal(root)).toBe(SECOND_STORE);
    } finally {
      await chmod(root, OWNER_ALL);
    }
  });
});

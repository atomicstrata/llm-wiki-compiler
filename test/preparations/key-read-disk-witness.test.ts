/**
 * @file test/preparations/key-read-disk-witness.test.ts
 * @description A BEFORE-AND-AFTER WITNESS for the preparation key read on the
 * real local disk. It calls only the two ROOT FORMS, `readPreparationKey` and
 * `readPreparationKeyEpoch`, which exist before and after the key read is bound
 * to its own leaf, so the same bytes of this file can run on both sides of that
 * change and must give the same answers.
 *
 * WHAT IT PINS. Each case writes one small key leaf, or none, and asserts the
 * WHOLE answer of both root forms: the healthy key with its bytes and epoch;
 * the two kinds of absence; owner-mode refusals; the link-count rule with and
 * without the one reserved companion alias; a leaf that is a link or a
 * directory; and the text rules a healthy leaf must still meet (canonical
 * base64 of exactly 32 bytes, valid UTF-8, within the byte cap).
 *
 * WHAT IT DOES NOT PIN. It cannot see the order in which the reader runs its
 * owner-mode check and its link check, or that it closes its file handle: an
 * outside observer gets the same answer either way. It races nothing, so it is
 * not evidence about a leaf swapped during the read. The key bytes here are a
 * fixed test pattern, never a real key. The mode cases need POSIX permission
 * bits; on a platform without them the reader skips that check by design and
 * those cases would not hold, and this file makes no claim there.
 *
 * EVERY DIRECTORY HERE is created by the shared temp-root tracker and removed
 * by it after each case. No path is ever handed to it for removal.
 */

import { chmod, link, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { MAX_PREPARATION_KEY_FILE_BYTES } from "../../src/preparations/constants.js";
import { readPreparationKey, readPreparationKeyEpoch } from "../../src/preparations/key-epoch.js";
import { preparationKeyFile } from "../../src/preparations/paths.js";
import { preparationKeyEpochId } from "../../src/preparations/run-integrity.js";
import { durableTempPath } from "../../src/utils/atomic-write-no-replace-durable.js";
import { tempRootTracker } from "../temp-roots.js";

const OWN_PREFIX = "preparation-key-read-witness-";
const KEY_BYTES = 32;
const OWNER_ONLY = 0o600;
const GROUP_READABLE = 0o640;
const OWNER_READ_ONLY = 0o400;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** A fixed test pattern, bytes 1 to 32. Not a real key. */
const KEY = Buffer.from(Array.from({ length: KEY_BYTES }, (_, index) => index + 1));
const KEY_TEXT = KEY.toString("base64");
const UNAVAILABLE = { key: { status: "unavailable" }, epoch: { status: "unavailable" } };
const ABSENT = { key: { status: "absent" }, epoch: { status: "absent" } };
const HEALTHY = {
  key: { status: "ok", key: KEY, keyEpochId: preparationKeyEpochId(KEY) },
  epoch: { status: "ok", keyEpochId: preparationKeyEpochId(KEY) },
};

const roots = tempRootTracker();
afterEach(() => roots.cleanup());

/** A new project root with an empty `.llmwiki` store directory. */
async function emptyStore(): Promise<string> {
  const root = await roots.create(OWN_PREFIX);
  await mkdir(path.dirname(preparationKeyFile(root)));
  return root;
}

/** A new project root whose key leaf holds `body` with permission bits `mode`. */
async function storeWithKeyLeaf(body: string | Buffer, mode = OWNER_ONLY): Promise<string> {
  const root = await emptyStore();
  await writeFile(preparationKeyFile(root), body);
  await chmod(preparationKeyFile(root), mode);
  return root;
}

/** The whole answer of both root forms for one project root. */
async function bothForms(root: string): Promise<{ key: unknown; epoch: unknown }> {
  return { key: await readPreparationKey(root), epoch: await readPreparationKeyEpoch(root) };
}

/** The key's text with its last data character changed so it decodes to the same bytes but is not canonical. */
function sameBytesNotCanonical(): string {
  const last = KEY_TEXT.length - 2;
  const loosened = BASE64_ALPHABET[BASE64_ALPHABET.indexOf(KEY_TEXT[last] ?? "") | 1];
  return `${KEY_TEXT.slice(0, last)}${loosened}=`;
}

describe("preparation key read on the local disk: the healthy leaf and absence", () => {
  it("W1 an owner-only leaf holding the canonical text is the key and its epoch", async () => {
    const root = await storeWithKeyLeaf(KEY_TEXT);
    expect(await bothForms(root)).toEqual(HEALTHY);
  });

  it("W1 the epoch form answers with a status and an epoch and nothing else", async () => {
    const root = await storeWithKeyLeaf(KEY_TEXT);
    expect(Object.keys(await readPreparationKeyEpoch(root)).sort()).toEqual(["keyEpochId", "status"]);
  });

  it("W2 a store with no key leaf, and a project with no store, are both absent", async () => {
    expect(await bothForms(await emptyStore())).toEqual(ABSENT);
    expect(await bothForms(await roots.create(OWN_PREFIX))).toEqual(ABSENT);
  });
});

describe("preparation key read on the local disk: owner and mode", () => {
  it("W3 a leaf readable by the group is unavailable, with the same healthy text", async () => {
    expect(await bothForms(await storeWithKeyLeaf(KEY_TEXT, GROUP_READABLE))).toEqual(UNAVAILABLE);
  });

  it("W3 a leaf that is not exactly owner read-write is unavailable", async () => {
    expect(await bothForms(await storeWithKeyLeaf(KEY_TEXT, OWNER_READ_ONLY))).toEqual(UNAVAILABLE);
  });
});

describe("preparation key read on the local disk: the link count", () => {
  it("W4 a second link under any other name makes the leaf unavailable", async () => {
    const root = await storeWithKeyLeaf(KEY_TEXT);
    await link(preparationKeyFile(root), path.join(root, "another-name"));
    expect(await bothForms(root)).toEqual(UNAVAILABLE);
  });

  it("W4 a second link that is the one reserved companion alias leaves the key healthy", async () => {
    const root = await storeWithKeyLeaf(KEY_TEXT);
    await link(preparationKeyFile(root), durableTempPath(preparationKeyFile(root)));
    expect(await bothForms(root)).toEqual(HEALTHY);
  });

  it("W4 the reserved alias plus one more link is three links, and unavailable", async () => {
    const root = await storeWithKeyLeaf(KEY_TEXT);
    await link(preparationKeyFile(root), durableTempPath(preparationKeyFile(root)));
    await link(preparationKeyFile(root), path.join(root, "another-name"));
    expect(await bothForms(root)).toEqual(UNAVAILABLE);
  });

  it("W4 a file at the reserved alias that is NOT the key's own second link does not excuse another link", async () => {
    const root = await storeWithKeyLeaf(KEY_TEXT);
    await link(preparationKeyFile(root), path.join(root, "another-name"));
    await writeFile(durableTempPath(preparationKeyFile(root)), KEY_TEXT, { mode: OWNER_ONLY });
    expect(await bothForms(root)).toEqual(UNAVAILABLE);
  });

  it("W4 a wrong mode and a stray link together are unavailable", async () => {
    const root = await storeWithKeyLeaf(KEY_TEXT, GROUP_READABLE);
    await link(preparationKeyFile(root), path.join(root, "another-name"));
    expect(await bothForms(root)).toEqual(UNAVAILABLE);
  });
});

describe("preparation key read on the local disk: a leaf that is not a plain file", () => {
  it("W5 a symbolic link to a healthy key outside the store is unavailable, not followed", async () => {
    const root = await emptyStore();
    await writeFile(path.join(root, "outside-key"), KEY_TEXT, { mode: OWNER_ONLY });
    await symlink(path.join(root, "outside-key"), preparationKeyFile(root));
    expect(await bothForms(root)).toEqual(UNAVAILABLE);
  });

  it("W5 a directory where the key leaf should be is unavailable", async () => {
    const root = await emptyStore();
    await mkdir(preparationKeyFile(root));
    expect(await bothForms(root)).toEqual(UNAVAILABLE);
  });
});

describe("preparation key read on the local disk: the text of a healthy leaf", () => {
  it.each([
    ["an empty leaf", ""],
    ["the canonical text followed by a newline", `${KEY_TEXT}\n`],
    ["the canonical text without its padding", KEY_TEXT.slice(0, -1)],
    ["the canonical text of 31 bytes", KEY.subarray(1).toString("base64")],
    ["the canonical text of 33 bytes", Buffer.concat([KEY, KEY.subarray(0, 1)]).toString("base64")],
    ["a URL-safe character in place of the first one", `-${KEY_TEXT.slice(1)}`],
    ["text that decodes to the same bytes but is not canonical", sameBytesNotCanonical()],
  ])("W6 %s is unavailable", async (_name, body) => {
    expect(body).not.toBe(KEY_TEXT);
    expect(await bothForms(await storeWithKeyLeaf(body))).toEqual(UNAVAILABLE);
  });

  it("W6 the non-canonical text really does decode to the key's bytes", () => {
    expect(Buffer.from(sameBytesNotCanonical(), "base64").equals(KEY)).toBe(true);
  });

  it("W7 bytes that are not valid UTF-8 are unavailable", async () => {
    const notUtf8 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(KEY_TEXT)]);
    expect(await bothForms(await storeWithKeyLeaf(notUtf8))).toEqual(UNAVAILABLE);
  });

  it("W7 a leaf one byte over the key file cap is unavailable", async () => {
    const overCap = "A".repeat(MAX_PREPARATION_KEY_FILE_BYTES + 1);
    expect(await bothForms(await storeWithKeyLeaf(overCap))).toEqual(UNAVAILABLE);
  });
});

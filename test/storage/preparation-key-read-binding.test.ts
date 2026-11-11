/**
 * @file test/storage/preparation-key-read-binding.test.ts
 * @description The preparation KEY READ's real body, `readPreparationKeyFrom`,
 * and its epoch form, run from memory. What is pinned is the reader's own
 * decisions: the one leaf read under the key cap, the three statuses, the
 * canonical base64 of exactly 32 bytes, and the epoch derived from the bytes.
 * The last block couples it to the real run read, so a real run is parsed and
 * its HMAC really compared with the key THIS body decoded.
 *
 * WHAT KIND OF TEST THIS IS. The bodies run FROM MEMORY OVER TEXT THAT WAS
 * MINTED ON DISK BY THE REAL WRITER. Once, before the cases, one preparation is
 * staged with the shared fixture in a directory the shared temp-root tracker
 * creates; the key leaf's text and the run leaf's text are copied into memory;
 * and the tracker removes that directory. No case is given a path, and one
 * case shows the directory is gone. The key is the fixture's freshly minted
 * one, used nowhere else.
 *
 * WHAT THIS IS NOT. The in-memory leaf confines nothing, opens nothing, and
 * checks no owner, mode, link count or byte cap: it records the cap the body
 * asked for and returns the text it holds. So this is NOT evidence of
 * confinement, of key-file health, of cap enforcement or of handle closure.
 * Those stay on the local-disk side and are witnessed on a real disk in
 * `test/preparations/key-read-disk-witness.test.ts`. The lifecycle
 * observation's open-handle key read is not exercised here. Nothing here
 * selects a backend.
 */

import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MAX_PREPARATION_KEY_FILE_BYTES, MAX_PREPARATION_RUN_BYTES } from "../../src/preparations/constants.js";
import {
  decodePreparationKey, readPreparationKeyEpochFrom, readPreparationKeyFrom, type PreparationKeyLeafReads,
} from "../../src/preparations/key-epoch.js";
import { preparationKeyFile, preparationPaths } from "../../src/preparations/paths.js";
import { preparationKeyEpochId } from "../../src/preparations/run-integrity.js";
import { parsePreparationRun } from "../../src/preparations/run-parse.js";
import { readPreparationRunFrom, type PreparationRunLeafReads } from "../../src/preparations/run-store.js";
import type { PreparationRunBinding } from "../../src/preparations/run-types.js";
import type { CappedLeafRead } from "../../src/utils/confined-read.js";
import { stagePreparation } from "../preparations/lifecycle-fixture.js";
import { tempRootTracker } from "../temp-roots.js";
import { runTextWithLastIntegrityDigitFlipped } from "./flipped-integrity.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const OWN_PREFIX = "preparation-key-read-binding-";
const KEY_BYTES = 32;
const OTHER_KEY_BYTE = 9;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BOOM = new Error("the key leaf read rejected");
/** A second canonical key text, of a key that signed nothing. */
const OTHER_KEY_TEXT = Buffer.alloc(KEY_BYTES, OTHER_KEY_BYTE).toString("base64");
const RUN_INVALID = { status: "unavailable", detail: "run-invalid", code: "run-integrity-invalid" };

/** The text copied into memory from the one staged preparation. */
interface MintedText {
  dir: string;
  binding: PreparationRunBinding;
  keyText: string;
  runText: string;
}

let minted: MintedText;
const ownRoots = tempRootTracker();

beforeAll(async () => {
  const dir = await ownRoots.create(OWN_PREFIX);
  const { binding } = await stagePreparation(dir);
  const runFile = preparationPaths(dir, binding.workspaceId).runFile(binding.runId);
  minted = { dir, binding, keyText: await readFile(preparationKeyFile(dir), "utf8"), runText: await readFile(runFile, "utf8") };
  await ownRoots.cleanup();
});
// Only matters when the hook above threw before its own cleanup.
afterAll(() => ownRoots.cleanup());

/** An in-memory key leaf that records each cap it was asked under and answers with `leaf`. */
function keyLeafOf(leaf: CappedLeafRead, caps: number[] = []): PreparationKeyLeafReads {
  return {
    readKeyLeaf: async (maxBytes) => {
      caps.push(maxBytes);
      return leaf;
    },
  };
}

/** In-memory run leaves whose KEY comes from the real key body over `keyLeaf`. */
function runLeavesOver(runLeaf: CappedLeafRead, keyLeaf: CappedLeafRead, order: string[] = []): PreparationRunLeafReads {
  return {
    readRunLeaf: async (_binding, maxBytes) => {
      order.push(`run-leaf under ${maxBytes}`);
      return runLeaf;
    },
    readKey: () => {
      order.push("key");
      return readPreparationKeyFrom(keyLeafOf(keyLeaf));
    },
  };
}

/** `text` with its last data character changed: the same decoded bytes, not the canonical text. */
function sameBytesNotCanonical(text: string): string {
  const last = text.length - 2;
  return `${text.slice(0, last)}${BASE64_ALPHABET[BASE64_ALPHABET.indexOf(text[last] ?? "") | 1]}=`;
}

/** The staged run text with the last hex digit of its `integrity` field flipped. */
function runTextWithIntegrityFlipped(): string {
  const { integrity } = parsePreparationRun(minted.runText, minted.binding);
  return runTextWithLastIntegrityDigitFlipped(minted.runText, integrity);
}

describe("key read from memory: the fixture", () => {
  it("K0 the directory the text was minted in is gone before any case runs", () => {
    expectMintingDirectoryRemoved(minted.dir, OWN_PREFIX);
  });
});

describe("key read from memory: the healthy leaf", () => {
  it("K1 the real text is the key the codec decodes, with the epoch the staged run is bound to", async () => {
    const caps: number[] = [];
    const read = await readPreparationKeyFrom(keyLeafOf({ kind: "ok", body: minted.keyText }, caps));
    const decoded = decodePreparationKey(minted.keyText);
    expect(decoded).toHaveLength(KEY_BYTES);
    expect(read).toEqual({ status: "ok", key: decoded, keyEpochId: minted.binding.keyEpochId });
    expect(caps).toEqual([MAX_PREPARATION_KEY_FILE_BYTES]);
  });

  it("K2 another canonical key is accepted too, under its own epoch: the body trusts bytes, not a particular key", async () => {
    const other = Buffer.alloc(KEY_BYTES, OTHER_KEY_BYTE);
    expect(await readPreparationKeyFrom(keyLeafOf({ kind: "ok", body: OTHER_KEY_TEXT })))
      .toEqual({ status: "ok", key: other, keyEpochId: preparationKeyEpochId(other) });
    expect(preparationKeyEpochId(other)).not.toBe(minted.binding.keyEpochId);
  });
});

describe("key read from memory: what the leaf says", () => {
  it("K3 an absent leaf and an unavailable leaf keep their own status, after one read under the cap", async () => {
    const caps: number[] = [];
    expect(await readPreparationKeyFrom(keyLeafOf({ kind: "absent" }, caps))).toEqual({ status: "absent" });
    expect(await readPreparationKeyFrom(keyLeafOf({ kind: "unavailable" }, caps))).toEqual({ status: "unavailable" });
    expect(caps).toEqual([MAX_PREPARATION_KEY_FILE_BYTES, MAX_PREPARATION_KEY_FILE_BYTES]);
  });

  it("K4 a throwing or rejecting leaf read is not caught: both forms reject with the same object", async () => {
    const throwing: PreparationKeyLeafReads = { readKeyLeaf: () => { throw BOOM; } };
    const rejecting: PreparationKeyLeafReads = { readKeyLeaf: () => Promise.reject(BOOM) };
    for (const leaves of [throwing, rejecting]) {
      await expect(readPreparationKeyFrom(leaves)).rejects.toBe(BOOM);
      await expect(readPreparationKeyEpochFrom(leaves)).rejects.toBe(BOOM);
    }
  });
});

describe("key read from memory: the codec decides, and a refusal is unavailable", () => {
  it("K5 text that is not the canonical base64 of exactly 32 bytes is unavailable", async () => {
    const real = Buffer.from(minted.keyText, "base64");
    const refused = [
      "", `${minted.keyText}\n`, ` ${minted.keyText}`, minted.keyText.slice(0, -1), `-${minted.keyText.slice(1)}`,
      real.subarray(1).toString("base64"), Buffer.concat([real, real.subarray(0, 1)]).toString("base64"),
      sameBytesNotCanonical(minted.keyText),
    ];
    for (const body of refused) {
      expect(await readPreparationKeyFrom(keyLeafOf({ kind: "ok", body }))).toEqual({ status: "unavailable" });
    }
    expect(new Set(refused).size).toBe(refused.length);
    expect(refused).not.toContain(minted.keyText);
  });

  it("K6 the non-canonical text decodes to the real key's bytes, so only the canonical rule refuses it", () => {
    const loose = sameBytesNotCanonical(minted.keyText);
    expect(Buffer.from(loose, "base64").equals(Buffer.from(minted.keyText, "base64"))).toBe(true);
    expect(decodePreparationKey(loose)).toBeNull();
  });
});

describe("key read from memory: the epoch form hands on no key bytes", () => {
  it("K7 the ok answer is a status and an epoch and nothing else, after one leaf read", async () => {
    const caps: number[] = [];
    const read = await readPreparationKeyEpochFrom(keyLeafOf({ kind: "ok", body: minted.keyText }, caps));
    expect(read).toEqual({ status: "ok", keyEpochId: minted.binding.keyEpochId });
    expect(Object.keys(read).sort()).toEqual(["keyEpochId", "status"]);
    expect(caps).toEqual([MAX_PREPARATION_KEY_FILE_BYTES]);
  });

  it("K8 absent, unavailable and undecodable leaves answer as the key form does", async () => {
    expect(await readPreparationKeyEpochFrom(keyLeafOf({ kind: "absent" }))).toEqual({ status: "absent" });
    expect(await readPreparationKeyEpochFrom(keyLeafOf({ kind: "unavailable" }))).toEqual({ status: "unavailable" });
    expect(await readPreparationKeyEpochFrom(keyLeafOf({ kind: "ok", body: `${minted.keyText}\n` })))
      .toEqual({ status: "unavailable" });
  });
});

describe("key read coupled to the real run read: real parsing and a real HMAC comparison", () => {
  it("K9 the staged run authenticates with the key this body decoded: run leaf first, then the key", async () => {
    const order: string[] = [];
    const leaves = runLeavesOver({ kind: "ok", body: minted.runText }, { kind: "ok", body: minted.keyText }, order);
    expect(await readPreparationRunFrom(leaves, minted.binding))
      .toEqual({ status: "ok", run: parsePreparationRun(minted.runText, minted.binding) });
    expect(order).toEqual([`run-leaf under ${MAX_PREPARATION_RUN_BYTES}`, "key"]);
  });

  it("K10 one flipped integrity digit fails the HMAC comparison against the decoded key", async () => {
    const altered = runTextWithIntegrityFlipped();
    const staged = parsePreparationRun(minted.runText, minted.binding);
    const parsed = parsePreparationRun(altered, minted.binding);
    expect(parsed.integrity).not.toBe(staged.integrity);
    expect({ ...parsed, integrity: staged.integrity }).toEqual(staged);
    const leaves = runLeavesOver({ kind: "ok", body: altered }, { kind: "ok", body: minted.keyText });
    expect(await readPreparationRunFrom(leaves, minted.binding)).toEqual(RUN_INVALID);
  });

  it("K11 KEY-EPOCH CHECK: another canonical key decodes, and the run is refused as not of that key's epoch", async () => {
    const leaves = runLeavesOver({ kind: "ok", body: minted.runText }, { kind: "ok", body: OTHER_KEY_TEXT });
    expect(await readPreparationRunFrom(leaves, minted.binding)).toEqual(RUN_INVALID);
  });

  it("K12 a missing key, and a key leaf that is unavailable or does not decode, keep the run read's two codes", async () => {
    const run: CappedLeafRead = { kind: "ok", body: minted.runText };
    const unreadable = { status: "unavailable", detail: "key-unreadable", code: "integrity-key-unreadable" };
    expect(await readPreparationRunFrom(runLeavesOver(run, { kind: "absent" }), minted.binding))
      .toEqual({ status: "unavailable", detail: "key-missing", code: "integrity-key-missing" });
    expect(await readPreparationRunFrom(runLeavesOver(run, { kind: "unavailable" }), minted.binding)).toEqual(unreadable);
    expect(await readPreparationRunFrom(runLeavesOver(run, { kind: "ok", body: `${minted.keyText}\n` }), minted.binding))
      .toEqual(unreadable);
  });

  it("K13 an absent run leaf answers absent and the key leaf is never asked", async () => {
    const order: string[] = [];
    const leaves = runLeavesOver({ kind: "absent" }, { kind: "ok", body: minted.keyText }, order);
    expect(await readPreparationRunFrom(leaves, minted.binding)).toEqual({ status: "absent" });
    expect(order).toEqual([`run-leaf under ${MAX_PREPARATION_RUN_BYTES}`]);
  });
});

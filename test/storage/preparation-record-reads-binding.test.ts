/**
 * @file test/storage/preparation-record-reads-binding.test.ts
 * @description The two preparation RECORD READERS' real bodies,
 * `readPreparationManifestFrom` and `readPreparationRunFrom`, run from memory.
 * What is pinned is each reader's own decisions: the cap it asks for, the
 * canonical-bytes rule and the identity binding of a manifest, the order leaf
 * then key of a run, every typed status, code and detail, and REAL PARSING AND
 * REAL AUTHENTICATION of a run with the real key.
 *
 * WHAT KIND OF TEST THIS IS. The bodies run FROM MEMORY OVER BYTES THAT WERE
 * MINTED ON DISK BY THE REAL WRITER. It is not a test with no disk in it. Once,
 * before the cases, it stages one preparation with the shared fixture inside a
 * directory THIS FILE has the shared temp-root tracker create, copies the
 * manifest bytes, the
 * run text, the key and the active scan's result into memory, and then removes
 * that one directory. Signing a run needs the real writer; a second signer here
 * would be a copy of the thing under test. After the copy no case reads that
 * directory, and one case shows it is gone.
 *
 * THE ONLY THING THIS FILE EVER REMOVES is the directory it created itself. The
 * tracker in `test/temp-roots.ts` creates it with `mkdtemp`, directly inside the
 * operating system's temporary directory and under this file's own prefix, and
 * its cleanup removes only the directories that same tracker created. No path
 * is ever handed to it for removal, so this file never removes a project, a
 * runtime checkout, or a path taken from anywhere else.
 *
 * THE LAST BLOCK calls the two ROOT FORMS with unsafe identities. Each fails at
 * path derivation, before any file is read, so those three cases show the real
 * local-disk leaves keep the two identity failures apart. They read nothing.
 *
 * WHAT THIS IS NOT. The in-memory leaves confine nothing, follow no link rule,
 * check no reserved companion and enforce no cap: they log the cap the body
 * asked for and return the bytes they hold. So this is NOT evidence of
 * confinement, of cap enforcement, or of the key file's health. The
 * composition case runs the accepted lookup and scan bodies over these two
 * bodies, but its lifecycle capture is SCRIPTED AS UNAVAILABLE, so no lifecycle
 * proof is asked for at all, and its active-scan answer is a replay of one real
 * scan taken before the directory was removed: it is NOT evidence of the proof,
 * the lease, provenance, authority, leaf classification, or of any journey
 * being closed. Nothing here selects a backend.
 */

import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "bun:test";
import { scanPreparationInventoryFrom, type PreparationInventoryReads } from "../../src/preparations/capacity.js";
import { MAX_PREPARATION_MANIFEST_BYTES, MAX_PREPARATION_RUN_BYTES } from "../../src/preparations/constants.js";
import type { PreparationId } from "../../src/preparations/ids.js";
import type { PreparationKeyRead } from "../../src/preparations/key-epoch.js";
import type { PreparationLifecycleReadV1 } from "../../src/preparations/lifecycle-snapshot/types.js";
import { parsePreparationManifest } from "../../src/preparations/manifest-parse.js";
import {
  readPreparationManifest, readPreparationManifestFrom, type PreparationManifestLeafReads,
} from "../../src/preparations/manifest-store.js";
import { preparationKeyEpochId } from "../../src/preparations/run-integrity.js";
import { parsePreparationRun } from "../../src/preparations/run-parse.js";
import {
  readPreparationRun, readPreparationRunFrom, type PreparationRunLeafReads,
} from "../../src/preparations/run-store.js";
import type { PreparationRunBinding } from "../../src/preparations/run-types.js";
import { resolvePreparationRunFrom, type PreparationRunLookupReads } from "../../src/preparations/service-run-lookup.js";
import type { CappedLeafRead, CappedLeafReadBuffer } from "../../src/utils/confined-read.js";
import { tempRootTracker } from "../temp-roots.js";
import { kindsOf } from "./call-log.js";
import { runTextWithLastIntegrityDigitFlipped } from "./flipped-integrity.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";
import { mintPreparationRecords, type MintedPreparationRecords } from "./minted-preparation-records.js";

type OkKey = Extract<PreparationKeyRead, { status: "ok" }>;

const OWN_PREFIX = "preparation-record-reads-binding-";
const OTHER_PREPARATION = `prp_${"a".repeat(32)}` as PreparationId;
const UNSAFE_WORKSPACE = "../escape";
const UNSAFE_PREPARATION = "prp_bad" as PreparationId;
const FOREIGN_KEY_BYTE = 7;
const BOOM = new Error("the read rejected");

let minted: MintedPreparationRecords;

/** Owns the one directory this file creates. Its cleanup removes only directories it created itself. */
const ownTemporaryRoots = tempRootTracker();

beforeAll(async () => {
  minted = await mintPreparationRecords(ownTemporaryRoots, OWN_PREFIX);
});

/** In-memory manifest leaves that log both steps and answer with `leaf`. */
function manifestLeavesOf(leaf: CappedLeafReadBuffer, log: unknown[][] = []): PreparationManifestLeafReads {
  return {
    manifestLeavesIn: (workspaceId) => {
      log.push(["workspace", workspaceId]);
      return async (preparationId, maxBytes) => {
        log.push(["manifest-leaf", preparationId, maxBytes]);
        return leaf;
      };
    },
  };
}

/** In-memory run leaves that log each call and answer with `leaf` and `key`. */
function runLeavesOf(leaf: CappedLeafRead, key: PreparationKeyRead, log: unknown[][] = []): PreparationRunLeafReads {
  return {
    readRunLeaf: async (binding, maxBytes) => {
      log.push(["run-leaf", binding, maxBytes]);
      return leaf;
    },
    readKey: async () => {
      log.push(["key"]);
      return key;
    },
  };
}

/** The staged run text with exactly one hex digit of its `integrity` field flipped. */
function runTextWithOneIntegrityDigitFlipped(): string {
  const integrity = minted.run.integrity;
  return runTextWithLastIntegrityDigitFlipped(minted.runText, integrity);
}

describe("record readers from memory: the fixture", () => {
  it("R0 the directory the records were minted in is gone before any case runs", () => {
    expectMintingDirectoryRemoved(minted.dir, OWN_PREFIX);
  });
});

describe("record readers from memory: the manifest read", () => {
  it("R1 the real bytes are the staged manifest, asked for in two steps under the manifest cap", async () => {
    const log: unknown[][] = [];
    const leaves = manifestLeavesOf({ kind: "ok", body: minted.manifestBytes }, log);
    const read = await readPreparationManifestFrom(leaves, minted.binding.workspaceId, minted.binding.preparationId);
    expect(read).toEqual({ status: "ok", manifest: minted.manifest });
    expect(log).toEqual([
      ["workspace", minted.binding.workspaceId],
      ["manifest-leaf", minted.binding.preparationId, MAX_PREPARATION_MANIFEST_BYTES],
    ]);
  });

  it("R2 bytes that differ only by whitespace parse, and are refused as not canonical", async () => {
    const padded = Buffer.concat([minted.manifestBytes, Buffer.from("\n", "utf8")]);
    expect(parsePreparationManifest(padded.toString("utf8"))).toEqual(minted.manifest);
    const leaves = manifestLeavesOf({ kind: "ok", body: padded });
    expect(await readPreparationManifestFrom(leaves, minted.binding.workspaceId, minted.binding.preparationId))
      .toEqual({ status: "invalid", detail: "preparation manifest is not canonical" });
  });

  it("R3 the real bytes asked for under another valid preparation id are an identity binding mismatch", async () => {
    const leaves = manifestLeavesOf({ kind: "ok", body: minted.manifestBytes });
    expect(await readPreparationManifestFrom(leaves, minted.binding.workspaceId, OTHER_PREPARATION))
      .toEqual({ status: "invalid", detail: "preparation manifest identity binding mismatch" });
  });

  it("R4 an absent leaf and an unavailable leaf keep their own answers", async () => {
    const { workspaceId, preparationId } = minted.binding;
    expect(await readPreparationManifestFrom(manifestLeavesOf({ kind: "absent" }), workspaceId, preparationId))
      .toEqual({ status: "absent" });
    expect(await readPreparationManifestFrom(manifestLeavesOf({ kind: "unavailable" }), workspaceId, preparationId))
      .toEqual({ status: "unavailable", detail: "manifest-leaf" });
  });
});

describe("record readers from memory: the manifest read's two identity steps", () => {
  it("R5 a throw from step one is unavailable identity, and no leaf is read", async () => {
    const leaves: PreparationManifestLeafReads = { manifestLeavesIn: () => { throw BOOM; } };
    expect(await readPreparationManifestFrom(leaves, minted.binding.workspaceId, minted.binding.preparationId))
      .toEqual({ status: "unavailable", detail: "identity" });
  });

  it("R5 a throw or a rejection from step two is not caught: the read rejects with the same object", async () => {
    const throwing: PreparationManifestLeafReads = { manifestLeavesIn: () => () => { throw BOOM; } };
    const rejecting: PreparationManifestLeafReads = { manifestLeavesIn: () => () => Promise.reject(BOOM) };
    for (const leaves of [throwing, rejecting]) {
      await expect(readPreparationManifestFrom(leaves, minted.binding.workspaceId, minted.binding.preparationId))
        .rejects.toBe(BOOM);
    }
  });
});

describe("record readers from memory: the run read's parsing and authentication", () => {
  it("R6 the real text with the real key is the staged run: leaf under the run cap, then key", async () => {
    const log: unknown[][] = [];
    const leaves = runLeavesOf({ kind: "ok", body: minted.runText }, minted.key, log);
    expect(await readPreparationRunFrom(leaves, minted.binding)).toEqual({ status: "ok", run: minted.run });
    expect(log).toEqual([["run-leaf", minted.binding, MAX_PREPARATION_RUN_BYTES], ["key"]]);
    expect(log[0]?.[1]).toBe(minted.binding);
  });

  it("R7 one flipped integrity digit still parses and still names this epoch, and fails the HMAC comparison", async () => {
    const altered = runTextWithOneIntegrityDigitFlipped();
    const parsed = parsePreparationRun(altered, minted.binding);
    expect(parsed.integrity).not.toBe(minted.run.integrity);
    expect({ ...parsed, integrity: minted.run.integrity }).toEqual(minted.run);
    expect(preparationKeyEpochId(minted.key.key)).toBe(parsed.keyEpochId);
    const leaves = runLeavesOf({ kind: "ok", body: altered }, minted.key);
    expect(await readPreparationRunFrom(leaves, minted.binding))
      .toEqual({ status: "unavailable", detail: "run-invalid", code: "run-integrity-invalid" });
  });

  it("R8 KEY-EPOCH CHECK: the real text with a foreign key is refused because the key is of another epoch", async () => {
    const foreign = Buffer.alloc(minted.key.key.length, FOREIGN_KEY_BYTE);
    const key: OkKey = { status: "ok", key: foreign, keyEpochId: preparationKeyEpochId(foreign) };
    expect(key.keyEpochId).not.toBe(minted.run.keyEpochId);
    const leaves = runLeavesOf({ kind: "ok", body: minted.runText }, key);
    expect(await readPreparationRunFrom(leaves, minted.binding))
      .toEqual({ status: "unavailable", detail: "run-invalid", code: "run-integrity-invalid" });
  });
});

describe("record readers from memory: the run read's leaf and key outcomes", () => {
  it("R9 an absent or unavailable leaf keeps its own answer, and the key is never read", async () => {
    const absent: unknown[][] = [];
    expect(await readPreparationRunFrom(runLeavesOf({ kind: "absent" }, minted.key, absent), minted.binding))
      .toEqual({ status: "absent" });
    const unavailable: unknown[][] = [];
    expect(await readPreparationRunFrom(runLeavesOf({ kind: "unavailable" }, minted.key, unavailable), minted.binding))
      .toEqual({ status: "unavailable", detail: "run-leaf", code: "run-leaf-unavailable" });
    expect([kindsOf(absent), kindsOf(unavailable)]).toEqual([["run-leaf"], ["run-leaf"]]);
  });

  it("R10 a missing or unreadable key has its own code, after the leaf was read", async () => {
    const leaf: CappedLeafRead = { kind: "ok", body: minted.runText };
    const log: unknown[][] = [];
    expect(await readPreparationRunFrom(runLeavesOf(leaf, { status: "absent" }, log), minted.binding))
      .toEqual({ status: "unavailable", detail: "key-missing", code: "integrity-key-missing" });
    expect(await readPreparationRunFrom(runLeavesOf(leaf, { status: "unavailable" }), minted.binding))
      .toEqual({ status: "unavailable", detail: "key-unreadable", code: "integrity-key-unreadable" });
    expect(kindsOf(log)).toEqual(["run-leaf", "key"]);
  });

  it("R11 a throwing or rejecting leaf read is unavailable identity, and the key is never read", async () => {
    const log: unknown[][] = [];
    const base = runLeavesOf({ kind: "absent" }, minted.key, log);
    const throwing: PreparationRunLeafReads = { ...base, readRunLeaf: () => { throw BOOM; } };
    const rejecting: PreparationRunLeafReads = { ...base, readRunLeaf: () => Promise.reject(BOOM) };
    for (const leaves of [throwing, rejecting]) {
      expect(await readPreparationRunFrom(leaves, minted.binding))
        .toEqual({ status: "unavailable", detail: "identity", code: "identity" });
    }
    expect(log).toEqual([]);
  });

  it("R12 a rejecting key read is not caught: the read rejects with the same object", async () => {
    const base = runLeavesOf({ kind: "ok", body: minted.runText }, minted.key);
    const leaves: PreparationRunLeafReads = { ...base, readKey: () => Promise.reject(BOOM) };
    await expect(readPreparationRunFrom(leaves, minted.binding)).rejects.toBe(BOOM);
  });
});

describe("record readers from memory: composed under the accepted scan and lookup bodies", () => {
  it("R13 the staged run is located, parsed and authenticated from memory, with its directory gone", async () => {
    const manifestLeaves = manifestLeavesOf({ kind: "ok", body: minted.manifestBytes });
    const runLeaves = runLeavesOf({ kind: "ok", body: minted.runText }, minted.key);
    const readKeyEpoch = async () => ({ status: "ok" as const, keyEpochId: minted.key.keyEpochId });
    const readRun = (binding: PreparationRunBinding) => readPreparationRunFrom(runLeaves, binding);
    const scanReads: PreparationInventoryReads = {
      assertLifecycleRead: () => Promise.reject(BOOM),
      scanActiveStore: async () => minted.activeScan,
      readManifest: (workspaceId, preparationId) => readPreparationManifestFrom(manifestLeaves, workspaceId, preparationId),
      readKeyEpoch, readRun,
    };
    const unavailableCapture: PreparationLifecycleReadV1 = { status: "unavailable", detail: "not captured in this test" };
    const lookupReads: PreparationRunLookupReads = {
      scanInventory: () => scanPreparationInventoryFrom(scanReads, unavailableCapture),
      readKeyEpoch, readRun,
      readEvidenceBytes: () => Promise.reject(BOOM),
    };
    expect(existsSync(minted.dir)).toBe(false);
    expect(await resolvePreparationRunFrom(lookupReads, minted.binding.runId))
      .toEqual({ ok: true, binding: minted.binding, run: minted.run });
  });
});

describe("record readers on the local disk: unsafe identities fail before any read", () => {
  it("R14 an unsafe workspace id is unavailable identity through the manifest root form", async () => {
    expect(await readPreparationManifest(minted.dir, UNSAFE_WORKSPACE, minted.binding.preparationId))
      .toEqual({ status: "unavailable", detail: "identity" });
  });

  it("R14 an unsafe preparation id rejects through the manifest root form", async () => {
    await expect(readPreparationManifest(minted.dir, minted.binding.workspaceId, UNSAFE_PREPARATION)).rejects.toThrow();
  });

  it("R14 an unsafe workspace id is unavailable identity through the run root form", async () => {
    const binding: PreparationRunBinding = { ...minted.binding, workspaceId: UNSAFE_WORKSPACE };
    expect(await readPreparationRun(minted.dir, binding))
      .toEqual({ status: "unavailable", detail: "identity", code: "identity" });
    expect(existsSync(minted.dir)).toBe(false);
  });
});

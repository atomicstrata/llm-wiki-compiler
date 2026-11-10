/**
 * @file test/storage/preparation-evidence-read-binding.test.ts
 * @description The two preparation EVIDENCE READS' real bodies,
 * `readPreparationEvidenceFrom` and `readPreparationEvidenceBytesFrom`, run
 * from memory. What is pinned is each reader's own decisions: the digest's
 * shape, checked before the store is asked; the byte cap and its two different
 * refusals; that a read which ended early is refused whatever the store says;
 * that the digest is compared only after an unchanged, complete read; and that
 * the byte form hands on nothing it has not verified. The last block couples
 * the byte body to the run lookup's real sealed-input reader.
 *
 * WHAT KIND OF TEST THIS IS. Most cases use small byte strings written here.
 * The coupled cases use BYTES MINTED ON DISK BY THE REAL WRITER: once, before
 * the cases, one preparation is staged in a directory the shared temp-root
 * tracker creates; the staged manifest and the sealed-input object's bytes are
 * copied into memory; and the tracker removes that directory. No case is given
 * a path.
 *
 * WHAT THE LEAF DOUBLE DOES. It lends a leaf that states a size and serves
 * positional reads from the bytes it holds, and it answers the store's one
 * physical question with whatever the case scripted. It logs every call. It
 * decides nothing about the evidence.
 *
 * WHAT THIS IS NOT. The double confines nothing, opens nothing, follows no link
 * rule and has no file identity: it is NOT evidence of confinement, of the
 * single-link rule, of a real post-read identity check, or of handle closure.
 * Those stay on the local-disk side; `evidence-store.test.ts`,
 * `evidence-read-bytes.test.ts`, `store-confinement.test.ts` and
 * `evidence-read-disk-witness.test.ts` show them on real files. The evidence
 * WRITERS are not exercised here. Nothing here selects a backend.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  readPreparationEvidenceBytesFrom, readPreparationEvidenceFrom,
  type PreparationEvidenceLeafReads, type PreparationEvidenceLocation, type PreparationEvidenceOpenLeaf,
} from "../../src/preparations/evidence-store.js";
import type { PreparationId } from "../../src/preparations/ids.js";
import type { PreparationManifestV1 } from "../../src/preparations/manifest-parse.js";
import { preparationPaths } from "../../src/preparations/paths.js";
import { readPreparationInitialInputFrom, type PreparationRunLookupReads } from "../../src/preparations/service-run-lookup.js";
import { stagePreparation } from "../preparations/lifecycle-fixture.js";
import { SEED_VALUE } from "../preparations/store-fixture.js";
import { tempRootTracker } from "../temp-roots.js";
import { kindsOf } from "./call-log.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const OWN_PREFIX = "preparation-evidence-read-binding-";
const MEBIBYTE = 1024 * 1024;
const WHERE: PreparationEvidenceLocation = { workspaceId: "research", preparationId: `prp_${"e".repeat(32)}` as PreparationId };
const BODY = Buffer.from("evidence bytes held in memory, never on a disk");
const BOOM = new Error("the store rejected");
const UNAVAILABLE = { status: "unavailable" };

/** What a case scripts for the one leaf the store lends. */
interface LeafScript {
  /** The bytes positional reads are served from. */
  held: Buffer;
  /** The size the store STATES; the held length when omitted. */
  statedSize?: number;
  /** The store's physical answer; `true` when omitted. An `Error` rejects. */
  unchanged?: boolean | Error;
  /** When set, every positional read rejects with it. */
  readFails?: Error;
}

/** The sealed input copied into memory from the one staged preparation. */
interface MintedSealedInput {
  dir: string;
  manifest: PreparationManifestV1;
  digest: string;
  bytes: Buffer;
}

let minted: MintedSealedInput;
const mintRoots = tempRootTracker();

beforeAll(async () => {
  const dir = await mintRoots.create(OWN_PREFIX);
  const { manifest } = await stagePreparation(dir);
  const digest = manifest.plan.initialInputSet.digest.replace(/^sha256:/, "");
  const file = preparationPaths(dir, manifest.workspaceId).evidenceFile(manifest.preparationId, digest);
  minted = { dir, manifest, digest, bytes: await readFile(file) };
  await mintRoots.cleanup();
});
// Only matters when the hook above threw before its own cleanup.
afterAll(() => mintRoots.cleanup());

/** The lowercase hex SHA-256 of `bytes`: the name evidence is stored under. */
function nameOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** One lent leaf over `script`, logging each read's length and the identity question. */
function leafOf(script: LeafScript, log: unknown[][]): PreparationEvidenceOpenLeaf {
  return {
    size: script.statedSize ?? script.held.byteLength,
    read: async (target, offset, length, position) => {
      log.push(["read", length, position]);
      if (script.readFails !== undefined) throw script.readFails;
      return { bytesRead: script.held.copy(target, offset, position, position + length) };
    },
    unchanged: async () => {
      log.push(["unchanged"]);
      if (script.unchanged instanceof Error) throw script.unchanged;
      return script.unchanged ?? true;
    },
  };
}

/** In-memory evidence leaves: log the ask, then answer with no leaf or lend the scripted one. */
function leavesOf(answer: "absent" | "unavailable" | LeafScript, log: unknown[][] = []): PreparationEvidenceLeafReads {
  return {
    useEvidenceLeaf: async (location, cleanDigest, use) => {
      log.push(["lend", location, cleanDigest]);
      if (typeof answer === "string") return { kind: answer };
      const value = await use(leafOf(answer, log));
      log.push(["released"]);
      return { kind: "used", value };
    },
  };
}

/** Both forms' answers over the same scripted leaf, each under `cap`. */
async function bothForms(script: LeafScript, digest: string, cap: number): Promise<unknown[]> {
  return [
    await readPreparationEvidenceFrom(leavesOf(script), WHERE, digest, cap),
    await readPreparationEvidenceBytesFrom(leavesOf(script), WHERE, digest, cap),
  ];
}

describe("evidence reads from memory: the fixture", () => {
  it("V0 the directory the sealed input was minted in is gone before any case runs", () => {
    expectMintingDirectoryRemoved(minted.dir, OWN_PREFIX);
  });
});

describe("evidence reads from memory: an intact leaf", () => {
  it("V1 the verify form hashes the lent leaf, asks the store's one question once, and answers ok with the byte count", async () => {
    const log: unknown[][] = [];
    expect(await readPreparationEvidenceFrom(leavesOf({ held: BODY }, log), WHERE, nameOf(BODY)))
      .toEqual({ status: "ok", byteCount: BODY.byteLength });
    expect(log[0]).toEqual(["lend", WHERE, nameOf(BODY)]);
    expect(kindsOf(log).filter((kind) => kind === "unchanged")).toHaveLength(1);
    expect(kindsOf(log).slice(-2)).toEqual(["unchanged", "released"]);
  });

  it("V2 the byte form returns exactly the held bytes, after one identity question", async () => {
    const log: unknown[][] = [];
    expect(await readPreparationEvidenceBytesFrom(leavesOf({ held: BODY }, log), WHERE, nameOf(BODY), BODY.byteLength))
      .toEqual({ status: "ok", bytes: BODY });
    expect(kindsOf(log)).toEqual(["lend", "read", "unchanged", "released"]);
  });

  it("V3 the byte form's cap is a required parameter; the verify form's is defaulted", () => {
    expect(readPreparationEvidenceBytesFrom).toHaveLength(4);
    expect(readPreparationEvidenceFrom).toHaveLength(3);
  });
});

describe("evidence reads from memory: what the store says about the leaf", () => {
  it("V4 no leaf is absent, and an untrusted leaf is unavailable, in both forms", async () => {
    expect(await readPreparationEvidenceFrom(leavesOf("absent"), WHERE, nameOf(BODY))).toEqual({ status: "absent" });
    expect(await readPreparationEvidenceBytesFrom(leavesOf("absent"), WHERE, nameOf(BODY), MEBIBYTE)).toEqual({ status: "absent" });
    expect(await readPreparationEvidenceFrom(leavesOf("unavailable"), WHERE, nameOf(BODY))).toEqual(UNAVAILABLE);
    expect(await readPreparationEvidenceBytesFrom(leavesOf("unavailable"), WHERE, nameOf(BODY), MEBIBYTE)).toEqual(UNAVAILABLE);
  });

  it("V5 a rejecting or throwing lend is not caught: both forms reject with the same object", async () => {
    const rejecting: PreparationEvidenceLeafReads = { useEvidenceLeaf: () => Promise.reject(BOOM) };
    const throwing: PreparationEvidenceLeafReads = { useEvidenceLeaf: () => { throw BOOM; } };
    for (const reads of [rejecting, throwing]) {
      await expect(readPreparationEvidenceFrom(reads, WHERE, nameOf(BODY))).rejects.toBe(BOOM);
      await expect(readPreparationEvidenceBytesFrom(reads, WHERE, nameOf(BODY), MEBIBYTE)).rejects.toBe(BOOM);
    }
  });
});

describe("evidence reads from memory: the digest's shape is checked before the store is asked", () => {
  it("V6 an uppercase, short or prefixed digest rejects in both forms, and nothing is lent", async () => {
    const log: unknown[][] = [];
    const words = "preparation evidence digest must be lowercase SHA-256";
    for (const digest of ["A".repeat(64), nameOf(BODY).slice(1), `sha256:${nameOf(BODY)}`]) {
      await expect(readPreparationEvidenceFrom(leavesOf({ held: BODY }, log), WHERE, digest)).rejects.toThrow(words);
      await expect(readPreparationEvidenceBytesFrom(leavesOf({ held: BODY }, log), WHERE, digest, MEBIBYTE)).rejects.toThrow(words);
    }
    expect(log).toEqual([]);
  });
});

describe("evidence reads from memory: the cap, and its two different refusals", () => {
  it("V7 a leaf exactly at the cap is ok in both forms", async () => {
    expect(await bothForms({ held: BODY }, nameOf(BODY), BODY.byteLength))
      .toEqual([{ status: "ok", byteCount: BODY.byteLength }, { status: "ok", bytes: BODY }]);
  });

  it("V8 one byte over is unavailable when verifying and over-cap when reading bytes", async () => {
    expect(await bothForms({ held: BODY }, nameOf(BODY), BODY.byteLength - 1))
      .toEqual([UNAVAILABLE, { status: "over-cap" }]);
  });

  it("V9 an over-cap leaf is refused on its stated size alone: no read and no identity question", async () => {
    const log: unknown[][] = [];
    await readPreparationEvidenceFrom(leavesOf({ held: BODY }, log), WHERE, nameOf(BODY), 1);
    await readPreparationEvidenceBytesFrom(leavesOf({ held: BODY }, log), WHERE, nameOf(BODY), 1);
    expect(kindsOf(log)).toEqual(["lend", "released", "lend", "released"]);
  });

  it("V10 a leaf that serves more than the cap after stating less is unavailable when verifying", async () => {
    const grown: LeafScript = { held: BODY, statedSize: 4 };
    expect(await readPreparationEvidenceFrom(leavesOf(grown), WHERE, nameOf(BODY), 8)).toEqual(UNAVAILABLE);
  });
});

describe("evidence reads from memory: a complete, unchanged read comes before the digest", () => {
  it("V11 one changed byte is a mismatch in both forms, and the byte form returns no bytes", async () => {
    const changed = Buffer.from(BODY);
    changed[0] = (changed[0] ?? 0) ^ 1;
    const [verified, read] = await bothForms({ held: changed }, nameOf(BODY), MEBIBYTE);
    expect(verified).toEqual({ status: "mismatch" });
    expect(read).toEqual({ status: "mismatch" });
    expect(read).not.toHaveProperty("bytes");
  });

  it("V12 a leaf the store says has changed is unavailable in both forms, even though its bytes would verify", async () => {
    expect(await bothForms({ held: BODY, unchanged: false }, nameOf(BODY), MEBIBYTE)).toEqual([UNAVAILABLE, UNAVAILABLE]);
  });

  it("V13 SHORT READ: reads that end early are unavailable when verifying, though the store says unchanged and the digest of what was read matches", async () => {
    const short: LeafScript = { held: BODY.subarray(0, BODY.byteLength - 3), statedSize: BODY.byteLength, unchanged: true };
    const log: unknown[][] = [];
    expect(await readPreparationEvidenceFrom(leavesOf(short, log), WHERE, nameOf(short.held), MEBIBYTE)).toEqual(UNAVAILABLE);
    expect(kindsOf(log).filter((kind) => kind === "unchanged")).toHaveLength(1);
  });

  it("V14 SHORT READ: the byte form is unavailable too: never a mismatch, never bytes", async () => {
    const short: LeafScript = { held: BODY.subarray(0, BODY.byteLength - 3), statedSize: BODY.byteLength, unchanged: true };
    for (const digest of [nameOf(BODY), nameOf(short.held)]) {
      const read = await readPreparationEvidenceBytesFrom(leavesOf(short), WHERE, digest, MEBIBYTE);
      expect(read).toEqual(UNAVAILABLE);
      expect(read).not.toHaveProperty("bytes");
    }
  });
});

describe("evidence reads from memory: a failing read or identity question is unavailable", () => {
  it("V15 a rejecting positional read is unavailable in both forms, and the leaf is still released", async () => {
    expect(await bothForms({ held: BODY, readFails: BOOM }, nameOf(BODY), MEBIBYTE)).toEqual([UNAVAILABLE, UNAVAILABLE]);
    const log: unknown[][] = [];
    await readPreparationEvidenceBytesFrom(leavesOf({ held: BODY, readFails: BOOM }, log), WHERE, nameOf(BODY), MEBIBYTE);
    expect(kindsOf(log)).toEqual(["lend", "read", "released"]);
  });

  it("V16 a rejecting identity question is unavailable in both forms", async () => {
    expect(await bothForms({ held: BODY, unchanged: BOOM }, nameOf(BODY), MEBIBYTE)).toEqual([UNAVAILABLE, UNAVAILABLE]);
  });
});

describe("evidence reads from memory: verifying never asks for more than one chunk", () => {
  it("V17 over a leaf of three mebibytes and five bytes, no read asks for more than one mebibyte", async () => {
    const big = Buffer.alloc(3 * MEBIBYTE + 5, 0x61);
    const log: unknown[][] = [];
    expect(await readPreparationEvidenceFrom(leavesOf({ held: big }, log), WHERE, nameOf(big)))
      .toEqual({ status: "ok", byteCount: big.byteLength });
    const asked = log.filter((call) => call[0] === "read").map((call) => call[1] as number);
    expect(Math.max(...asked)).toBe(MEBIBYTE);
    expect(asked.length).toBeGreaterThanOrEqual(4);
  });
});

describe("the byte read coupled to the run lookup's real sealed-input reader", () => {
  /** Lookup reads whose ONLY working member is the evidence byte read, over the real byte body. */
  function lookupOver(leaves: PreparationEvidenceLeafReads): PreparationRunLookupReads {
    return {
      scanInventory: () => Promise.reject(BOOM),
      readKeyEpoch: () => Promise.reject(BOOM),
      readRun: () => Promise.reject(BOOM),
      readEvidenceBytes: (location, digest, maxBytes) => readPreparationEvidenceBytesFrom(leaves, location, digest, maxBytes),
    };
  }

  it("V18 the staged sealed input is read from memory, verified, and decoded to the seed the fixture staged", async () => {
    const log: unknown[][] = [];
    const lookup = lookupOver(leavesOf({ held: minted.bytes }, log));
    expect(await readPreparationInitialInputFrom(lookup, minted.manifest)).toEqual({ ok: true, record: SEED_VALUE });
    const location = { workspaceId: minted.manifest.workspaceId, preparationId: minted.manifest.preparationId };
    expect(log[0]).toEqual(["lend", location, minted.digest]);
  });

  it("V19 one changed sealed byte is refused as a mismatch before anything is parsed", async () => {
    const changed = Buffer.from(minted.bytes);
    changed[0] = (changed[0] ?? 0) ^ 1;
    expect(await readPreparationInitialInputFrom(lookupOver(leavesOf({ held: changed })), minted.manifest))
      .toEqual({ ok: false, reason: "sealed input is mismatch" });
  });

  it("V20 no sealed leaf, and a sealed read that ended early, keep their own words", async () => {
    const short: LeafScript = { held: minted.bytes.subarray(0, 4), statedSize: minted.bytes.byteLength };
    expect(await readPreparationInitialInputFrom(lookupOver(leavesOf("absent")), minted.manifest))
      .toEqual({ ok: false, reason: "sealed input is absent" });
    expect(await readPreparationInitialInputFrom(lookupOver(leavesOf(short)), minted.manifest))
      .toEqual({ ok: false, reason: "sealed input is unavailable" });
  });
});

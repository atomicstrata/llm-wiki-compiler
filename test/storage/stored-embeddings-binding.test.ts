/**
 * @file test/storage/stored-embeddings-binding.test.ts
 * @description The stored-embedding reader as a WHOLE consumer with no project
 * directory: `readStoredEmbeddingsFrom` over `StoredEmbeddingReads`, and the
 * search read above it, `readEmbeddingStoreFrom`. The bodies exist only after
 * the reader was given reads of its own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Six small projects are minted on real disk. For each, the
 * private directory is made explicitly, and then its leaves are written from
 * BYTES THIS FILE HOLDS: a JSON index, a binary index beside a different JSON
 * index, a corrupt binary beside a valid JSON, a directory where the binary
 * would be, a JSON index of an older version, and a private directory with no
 * index. The real root-taking reader and search read answer each, and the directories are
 * removed before any case runs. Nothing is copied back off disk: the in-memory
 * double is given the same buffers that were written, so no byte passes through
 * a text decode on the way.
 *
 * WHAT RUNS FOR REAL IN MEMORY. Which leaf is authoritative, the second look at
 * the selected leaf, the cap chosen for each format, the binary decoder with its
 * strict text decode, the lenient JSON decode, the version parse, and every
 * reason string. The double answers three raw facts: the private directory, a
 * leaf's kind, and a leaf's bytes or null when over the cap. No format, decoded
 * store or verdict is handed in.
 *
 * WHAT IS NOT SHOWN. The writer `persistEmbeddingStore`, and the callers above
 * the reader (search, the scoped update, `collectStats`), all of which still
 * take a project root; the search read's identity and vector validation
 * (the embeddings validation suites). The double has no links, opens nothing and confines
 * nothing: what the disk decides about a linked private directory or a linked
 * leaf is shown ONLY by the two disk observations in the last block.
 */

import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { encodeBinaryStore, MAX_BINARY_STORE_BYTES } from "../../src/utils/embeddings-binary.js";
import { MAX_EMBEDDING_STORE_BYTES } from "../../src/utils/constants.js";
import * as storage from "../../src/utils/embeddings-storage.js";
import { readStoredEmbeddings, readStoredEmbeddingsFrom, type StoredEmbeddingRead, type StoredEmbeddingReads } from "../../src/utils/embeddings-storage.js";
import { readEmbeddingStore, readEmbeddingStoreFrom, type EmbeddingStore } from "../../src/utils/embeddings-store.js";
import { binaryFixture } from "../fixtures/binary-embedding-store.js";
import { tempRootTracker } from "../temp-roots.js";
import { enoent, mintOnceThenRemove } from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "stored-embeddings-";
const BIN = "embeddings.bin";
const JSON_LEAF = "embeddings.json";
const PRIVATE = "memory:private";
/** One leaf of a private directory: its bytes, or a directory standing where a file would be. */
type Leaf = Buffer | "directory";
type Leaves = Record<string, Leaf>;
const jsonOf = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

const BINARY_STORE = encodeBinaryStore({ ...binaryFixture(), model: "from-binary" });
const LEGACY_JSON = jsonOf({ ...binaryFixture(), model: "from-json" });
/** The leaves of each minted project, held here as the bytes that were written. */
const PROJECTS = {
  jsonOnly: { [JSON_LEAF]: LEGACY_JSON },
  binaryBesideJson: { [BIN]: BINARY_STORE, [JSON_LEAF]: LEGACY_JSON },
  corruptBinary: { [BIN]: Buffer.from("bad"), [JSON_LEAF]: LEGACY_JSON },
  directoryAsBinary: { [BIN]: "directory", [JSON_LEAF]: LEGACY_JSON },
  olderVersion: { [JSON_LEAF]: jsonOf({ version: 1, entries: [] }) },
  emptyPrivate: {},
} satisfies Record<string, Leaves>;

const tracker = tempRootTracker();
const minted: string[] = [];
const onDisk: Record<string, StoredEmbeddingRead> = {};
/** What the root-taking search read answered for each minted project. */
const searchable: Record<string, EmbeddingStore | null> = {};
/** What the disk reader did where a link stood: the rejection's name for a linked private directory, and the answer for a linked binary leaf. */
const linked: { privateDirectory?: string; binaryLeaf?: StoredEmbeddingRead } = {};

/** Make the private directory, then each leaf from the bytes held above. */
async function written(root: string, leaves: Leaves): Promise<void> {
  const dir = path.join(root, ".llmwiki");
  await mkdir(dir, { recursive: true });
  for (const [name, leaf] of Object.entries(leaves)) {
    if (leaf === "directory") await mkdir(path.join(dir, name));
    else await writeFile(path.join(dir, name), leaf);
  }
}

mintOnceThenRemove(tracker, async () => {
  for (const [name, leaves] of Object.entries(PROJECTS)) {
    const root = await tracker.create(PREFIX, { real: true });
    minted.push(root);
    await written(root, leaves);
    onDisk[name] = await readStoredEmbeddings(root);
    searchable[name] = await readEmbeddingStore(root);
  }
  const outside = await tracker.create(PREFIX, { real: true });
  await written(outside, { [JSON_LEAF]: LEGACY_JSON });
  const escaping = await tracker.create(PREFIX, { real: true });
  await symlink(path.join(outside, ".llmwiki"), path.join(escaping, ".llmwiki"));
  linked.privateDirectory = await readStoredEmbeddings(escaping).then(() => "resolved", (error: Error) => error.name);
  const leafLinked = await tracker.create(PREFIX, { real: true });
  await written(leafLinked, { [JSON_LEAF]: LEGACY_JSON });
  await symlink(path.join(outside, ".llmwiki", JSON_LEAF), path.join(leafLinked, ".llmwiki", BIN));
  linked.binaryLeaf = await readStoredEmbeddings(leafLinked);
  minted.push(outside, escaping, leafLinked);
});

/** The three raw facts over held bytes. `null` leaves mean there is no private directory. Every call is logged. */
function readsOver(leaves: Leaves | null, events: string[]): StoredEmbeddingReads {
  return {
    resolvePrivateDir: async () => { events.push("resolve"); return leaves === null ? null : PRIVATE; },
    leafKind: async (dir, name) => {
      events.push(`kind ${dir} ${name}`);
      const leaf = leaves?.[name];
      return leaf === undefined ? "absent" : leaf === "directory" ? "other" : "regular";
    },
    readLeafBytes: async (dir, name, maxBytes) => {
      events.push(`read ${dir} ${name} ${maxBytes}`);
      const leaf = leaves?.[name];
      if (leaf === undefined || leaf === "directory") throw enoent();
      return leaf.length > maxBytes ? null : leaf;
    },
  };
}

const reasonOf = (read: StoredEmbeddingRead): string => (read.kind === "unavailable" ? read.reason : read.kind);
const modelOf = (read: StoredEmbeddingRead): unknown => (read.kind === "parsed" ? read.parsed.store.model : read.kind);

describe("the stored-embedding reader over held bytes, with the directories gone", () => {
  it("S1 runs after every minting directory was removed", () => {
    expect(minted).toHaveLength(Object.keys(PROJECTS).length + 3);
    for (const root of minted) expectMintingDirectoryRemoved(root, PREFIX);
  });

  it("S2 answers every project exactly as the disk reader did", async () => {
    for (const [name, leaves] of Object.entries(PROJECTS)) {
      expect([name, await readStoredEmbeddingsFrom(readsOver(leaves, []))]).toEqual([name, onDisk[name]]);
    }
  });

  it("S3 lets a binary leaf win over a JSON one, and reads JSON only when no binary leaf is there", async () => {
    expect(modelOf(await readStoredEmbeddingsFrom(readsOver(PROJECTS.binaryBesideJson, [])))).toBe("from-binary");
    expect(modelOf(await readStoredEmbeddingsFrom(readsOver(PROJECTS.jsonOnly, [])))).toBe("from-json");
    const older = await readStoredEmbeddingsFrom(readsOver(PROJECTS.olderVersion, []));
    expect(older).toEqual({ kind: "parsed", parsed: { version: 1, store: { version: 1, entries: [] } } });
  });

  it("S4 looks at the binary leaf, then at the selected leaf again, then reads it under that format's cap", async () => {
    const [json, binary]: string[][] = [[], []];
    await readStoredEmbeddingsFrom(readsOver(PROJECTS.jsonOnly, json));
    await readStoredEmbeddingsFrom(readsOver(PROJECTS.binaryBesideJson, binary));
    expect(json).toEqual(["resolve", `kind ${PRIVATE} ${BIN}`, `kind ${PRIVATE} ${JSON_LEAF}`, `read ${PRIVATE} ${JSON_LEAF} ${MAX_EMBEDDING_STORE_BYTES}`]);
    expect(binary).toEqual(["resolve", `kind ${PRIVATE} ${BIN}`, `kind ${PRIVATE} ${BIN}`, `read ${PRIVATE} ${BIN} ${MAX_BINARY_STORE_BYTES}`]);
  });

  it("S5 answers absent with no private directory and with an empty one, asking nothing more than it must", async () => {
    const [none, empty]: string[][] = [[], []];
    expect(await readStoredEmbeddingsFrom(readsOver(null, none))).toEqual({ kind: "absent" });
    expect(await readStoredEmbeddingsFrom(readsOver(PROJECTS.emptyPrivate, empty))).toEqual({ kind: "absent" });
    expect([none, empty]).toEqual([["resolve"], ["resolve", `kind ${PRIVATE} ${BIN}`, `kind ${PRIVATE} ${JSON_LEAF}`]]);
  });

  it("S6 keeps a refused binary leaf authoritative: corrupt, not a regular file, and over the cap never fall back to JSON", async () => {
    const events: string[] = [];
    const overCap: StoredEmbeddingReads = { ...readsOver(PROJECTS.binaryBesideJson, events), readLeafBytes: async () => null };
    expect([
      reasonOf(await readStoredEmbeddingsFrom(readsOver(PROJECTS.corruptBinary, events))),
      reasonOf(await readStoredEmbeddingsFrom(readsOver(PROJECTS.directoryAsBinary, events))),
      reasonOf(await readStoredEmbeddingsFrom(overCap)),
    ]).toEqual([
      "Embedding index could not be read or failed integrity validation.",
      "Embedding index is not a regular file.",
      "Embedding index exceeds its byte limit.",
    ]);
    expect(events.filter((event) => event.includes(JSON_LEAF))).toEqual([]);
  });

  it("S7 decodes binary text strictly and JSON text leniently, and refuses a version it does not know", async () => {
    const badText = Buffer.from([0x7b, 0x22, 0x76, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
    const header = Buffer.alloc(12);
    header.write("LLMWEB01");
    header.writeUInt32LE(badText.length, 8);
    const lenient = Buffer.concat([Buffer.from('{"version":3,"model":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    expect(reasonOf(await readStoredEmbeddingsFrom(readsOver({ [BIN]: Buffer.concat([header, badText]) }, []))))
      .toBe("Embedding index could not be read or failed integrity validation.");
    expect(modelOf(await readStoredEmbeddingsFrom(readsOver({ [JSON_LEAF]: lenient }, [])))).toBe("�");
    expect(reasonOf(await readStoredEmbeddingsFrom(readsOver({ [JSON_LEAF]: jsonOf({ version: 4 }) }, []))))
      .toBe("Embedding index has an unsupported or invalid format.");
  });

  it("S8 says the binary leaf disappeared when the second look finds nothing, and does not turn to JSON", async () => {
    const events: string[] = [];
    const reads = readsOver(PROJECTS.binaryBesideJson, events);
    let looks = 0;
    const vanishing: StoredEmbeddingReads = { ...reads, leafKind: async (dir, name) => (++looks === 1 ? reads.leafKind(dir, name) : "absent") };
    expect(reasonOf(await readStoredEmbeddingsFrom(vanishing))).toBe("Binary index disappeared.");
    expect(events).toEqual(["resolve", `kind ${PRIVATE} ${BIN}`]);
  });

  it("S9 gives a failed first look its own reason, a failed second look the general one, and lets a directory refusal reject", async () => {
    const failure = new Error("planted lookup failure");
    const reads = readsOver(PROJECTS.jsonOnly, []);
    let looks = 0;
    const first: StoredEmbeddingReads = { ...reads, leafKind: async () => { throw failure; } };
    const second: StoredEmbeddingReads = { ...reads, leafKind: async (dir, name) => { if (++looks === 2) throw failure; return reads.leafKind(dir, name); } };
    expect(reasonOf(await readStoredEmbeddingsFrom(first))).toBe("Binary embedding index could not be inspected.");
    expect(reasonOf(await readStoredEmbeddingsFrom(second))).toBe("Embedding index could not be read or failed integrity validation.");
    await expect(readStoredEmbeddingsFrom({ ...reads, resolvePrivateDir: async () => { throw failure; } })).rejects.toBe(failure);
  });
});

describe("what a link does, from the disk reader's answers only", () => {
  it("K1 a private directory that is a link out of the project made the disk reader REJECT, not answer unavailable", () => {
    expect(linked.privateDirectory).toBe("PrivateDirConfinementError");
  });

  it("K2 a binary leaf that is a link was not followed and was not replaced by the JSON beside it", () => {
    expect(linked.binaryLeaf).toEqual({ kind: "unavailable", reason: "Embedding index is not a regular file." });
  });
});

describe("the search read over the same reads", () => {
  it("E1 answers every project exactly as the root-taking search read did", async () => {
    for (const [name, leaves] of Object.entries(PROJECTS)) {
      expect([name, await readEmbeddingStoreFrom(readsOver(leaves, []))]).toEqual([name, searchable[name]]);
    }
    expect([searchable.binaryBesideJson?.model, searchable.jsonOnly?.model, searchable.corruptBinary, searchable.emptyPrivate])
      .toEqual(["from-binary", "from-json", null, null]);
  });

  it("E2 lets a directory refusal reject, and never reaches the root-taking reader", async () => {
    const root = vi.spyOn(storage, "readStoredEmbeddings");
    const failure = new Error("planted refusal");
    await expect(readEmbeddingStoreFrom({ ...readsOver(PROJECTS.jsonOnly, []), resolvePrivateDir: async () => { throw failure; } })).rejects.toBe(failure);
    expect(root.mock.calls).toEqual([]);
  });

  it("E3 the root form reaches the incumbent root-taking reader with the root, and decides on its answer", async () => {
    const root = vi.spyOn(storage, "readStoredEmbeddings").mockResolvedValue({ kind: "unavailable", reason: "planted" });
    expect(await readEmbeddingStore("/project")).toBeNull();
    expect(root.mock.calls).toEqual([["/project"]]);
  });
});

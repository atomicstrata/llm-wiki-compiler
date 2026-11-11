/**
 * @file test/storage/embedding-store-persistence-binding.test.ts
 * @description The embedding store WRITER, WHOLE, over storage held in memory:
 * `persistEmbeddingStoreFrom` keeps an existing binary leaf authoritative,
 * refuses a non-regular one, writes JSON by default and binary on request,
 * serializes or encodes BEFORE the private directory is created, publishes
 * through one replacement, and prints the automatic-migration notice only
 * after that replacement succeeded. It exists only after the writer was given
 * a body of its own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Five projects are minted on real disk, once, and each tree
 * is copied BEFORE its disk ask (`mintCopiedBeforeAsk`): the writer changes the
 * disk, so a copy taken after the ask would start the memory replay from what
 * the disk was left with. Each project's OWN disk ask then runs its steps
 * through the real root form, under the step's opt-in, and settles each step
 * EXACTLY ONCE, followed by the notices it printed and what the private
 * directory then holds (each regular leaf's digest, or another entry's kind).
 * The minting directories are removed before any case runs. Before every
 * memory replay the copy is checked against the seed, LITERALLY: no private
 * directory for the three fresh projects, and the seeded backup and binary or
 * directory leaf for the other two. The memory side then runs the same steps
 * through the bound body over that copy, recording the replacement's locator
 * and bytes.
 *
 * WHAT A CAPTURED PUBLICATION IS. Bytes kept in a map the test owns. It shows
 * which leaf was chosen and what was handed over, nothing about atomic
 * replacement, confinement, durability or locking. The copy holds TEXT, so a
 * copied binary leaf is compared only as the seed's own bytes read as UTF-8,
 * and its digest is compared only after a step replaced it.
 *
 * AMBIENT INPUTS. The opt-in `LLMWIKI_BINARY_EMBEDDINGS` is stubbed per step
 * and every stub is undone after it. The notice goes to the process output
 * and is captured with a spy. No provider is configured or called. The
 * JSON-overflow store, the call log and the refused publication are MEMORY
 * ONLY; real capacity, links and access refusals stay with the incumbent
 * binary-storage, capacity and scale suites.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { restoreEnv, stubEnv } from "../stubs.js";
import { LLMWIKI_DIR } from "../../src/utils/constants.js";
import { encodeBinaryStore } from "../../src/utils/embeddings-binary.js";
import { persistEmbeddingStore, persistEmbeddingStoreFrom, type StoredEmbeddingWrites } from "../../src/utils/embeddings-storage.js";
import type { EmbeddingStoreV3 } from "../../src/utils/embeddings-store.js";
import * as output from "../../src/utils/output.js";
import { binaryFixture } from "../fixtures/binary-embedding-store.js";
import { writeFiles, type Copy } from "./copied-project.js";
import { privateDirLeaves, privateLeafStoreOf, type Leaves } from "./embedding-binding-doubles.js";
import { expectMintsRemovedThenSeeded, failureText, mintSeededScenarios } from "./scenario-mint.js";

const PREFIX = "embedding-store-persistence-binding-";
const MEM_ROOT = "/memory/project";
const NOTICE = "Embedding index exceeded the JSON limit; saved embeddings.bin. Future updates remain binary.";
const BACKUP = JSON.stringify({ version: 3, model: "old", dimensions: 0, entries: [], chunks: [] });
const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
const updated = (): EmbeddingStoreV3 => ({ ...binaryFixture(), model: "updated" });
const unencodable = (): EmbeddingStoreV3 => ({ ...binaryFixture(), entries: [{ ...binaryFixture().entries[0], vector: [1e39, 0] }] });
const unserializable = (): EmbeddingStoreV3 => ({ ...binaryFixture(), extra: 10n } as unknown as EmbeddingStoreV3);

type Persist = (store: EmbeddingStoreV3) => Promise<void>;
interface Step { optIn: string; store: () => EmbeddingStoreV3 }

const SCENARIOS = {
  absent: { seed: (root: string) => writeFiles(root, { "README.md": "x" }), steps: [{ optIn: "", store: binaryFixture }] },
  requested: { seed: (root: string) => writeFiles(root, { "README.md": "x" }),
    steps: [{ optIn: "true", store: unencodable }, { optIn: "true", store: binaryFixture }] },
  authority: { seed: async (root: string) => {
    await writeFiles(root, { [`${LLMWIKI_DIR}/embeddings.json`]: BACKUP });
    await writeFile(path.join(root, LLMWIKI_DIR, "embeddings.bin"), encodeBinaryStore(binaryFixture()));
  }, steps: [{ optIn: "", store: updated }] },
  nonregular: { seed: async (root: string) => {
    await writeFiles(root, { [`${LLMWIKI_DIR}/embeddings.json`]: BACKUP });
    await mkdir(path.join(root, LLMWIKI_DIR, "embeddings.bin"));
  }, steps: [{ optIn: "", store: binaryFixture }] },
  unserializable: { seed: (root: string) => writeFiles(root, { "README.md": "x" }), steps: [{ optIn: "", store: unserializable }] },
};
type Name = keyof typeof SCENARIOS;

/** Run steps in order under each step's opt-in, settling each exactly once, then reading the notices and the leaves. */
async function runSteps(steps: Step[], persist: Persist, leaves: () => Promise<Leaves>, log: string[] = []): Promise<string[]> {
  const printed: string[] = [];
  const notices = vi.spyOn(output, "note").mockImplementation((message) => { printed.push(message); log.push(`note ${message}`); });
  const outcomes: string[] = [];
  try {
    for (const step of steps) {
      stubEnv("LLMWIKI_BINARY_EMBEDDINGS", step.optIn);
      const settled = await persist(step.store()).then(() => "ok", failureText);
      restoreEnv();
      outcomes.push(JSON.stringify({ settled, notes: printed.splice(0), leaves: await leaves() }));
    }
  } finally { restoreEnv(); notices.mockRestore(); }
  return outcomes;
}

/** What the real private directory holds: each regular leaf's digest, or another entry's kind. */
const diskLeaves = (root: string): Promise<Leaves> => privateDirLeaves(root, (_name, bytes) => sha(bytes));

const minted = mintSeededScenarios(PREFIX, SCENARIOS,
  (root, name) => runSteps(SCENARIOS[name].steps, (store) => persistEmbeddingStore(root, store), () => diskLeaves(root)), true);

/** The writer's mechanisms over a copied tree: its looks, its creation, and a captured replacement that `refusal` rejects. */
function memoryWritesOf(copy: Copy, log: string[], refusal?: Error): { writes: StoredEmbeddingWrites; leaves: () => Promise<Leaves> } {
  const store = privateLeafStoreOf(copy, log, { prefix: "", dir: `${MEM_ROOT}/${LLMWIKI_DIR}`, refusal });
  return { writes: store.writes, leaves: () => store.leaves((_name, bytes) => sha(bytes)) };
}

/** The private directory each project was SEEDED with, as `name:kind` entries, or `null` when it had none. */
const SEEDED: Record<Name, string[] | null> = {
  absent: null, requested: null, unserializable: null,
  authority: ["embeddings.bin:file", "embeddings.json:file"],
  nonregular: ["embeddings.bin:directory", "embeddings.json:file"],
};

/** `name`'s copy, after requiring LITERALLY that it holds the seed and nothing a disk step wrote. */
function seededCopy(name: Name): Copy {
  const copy = minted[name]!.copy;
  const held = (leaf: string): string | undefined => copy.files.get(`${LLMWIKI_DIR}/${leaf}`);
  expect(copy.listings.get(LLMWIKI_DIR)?.map((entry) => `${entry.name}:${entry.kind}`).sort() ?? null).toEqual(SEEDED[name]);
  if (SEEDED[name] !== null) expect(held("embeddings.json")).toBe(BACKUP);
  if (name === "authority") expect(held("embeddings.bin")).toBe(encodeBinaryStore(binaryFixture()).toString("utf-8"));
  return copy;
}

/** Run `name` in memory from its seeded copy and require the disk's settled outcomes. */
async function expectDiskParity(name: Name, log: string[] = []): Promise<{ settled: string; notes: string[]; leaves: Leaves }[]> {
  const { writes, leaves } = memoryWritesOf(seededCopy(name), log);
  const outcomes = await runSteps(SCENARIOS[name].steps, (store) => persistEmbeddingStoreFrom(writes, store), leaves, log);
  expect(outcomes).toEqual(minted[name]!.onDisk);
  return outcomes.map((outcome) => JSON.parse(outcome));
}

/** A valid store whose JSON exceeds its 64 MiB limit, built from one shared 100,000-character summary. */
function overflowStore(): EmbeddingStoreV3 {
  const store = binaryFixture();
  const summary = "研".repeat(100_000);
  store.chunks = [];
  store.entries = Array.from({ length: 240 }, (_, index) => ({ ...store.entries[0], pageId: `concepts/${index}`, summary }));
  return store;
}

describe("the embedding store writer over copied projects, with every minting directory gone", () => {
  it("P1 runs after every minting directory was removed, on copies holding exactly the seed", () => {
    expectMintsRemovedThenSeeded(minted, PREFIX, Object.keys(SCENARIOS) as Name[], seededCopy);
  });

  it("P2 writes a small store as JSON by default, creating the private directory, as the disk did", async () => {
    const [only] = await expectDiskParity("absent");
    expect(only).toEqual({ settled: "ok", notes: [], leaves: { "embeddings.json": sha(JSON.stringify(binaryFixture(), null, 2)) } });
  });

  it("P3 refuses an unencodable store before creating anything, then writes binary on request without a notice, as the disk did", async () => {
    const [refused, written] = await expectDiskParity("requested");
    expect(refused).toEqual({ settled: "EmbeddingIntegrityError: Embedding integrity error: vector overflows finite Float32", notes: [], leaves: null });
    expect(written).toEqual({ settled: "ok", notes: [], leaves: { "embeddings.bin": sha(encodeBinaryStore(binaryFixture())) } });
  });

  it("P4 keeps an existing binary leaf authoritative without the opt-in and leaves the JSON backup alone, as the disk did", async () => {
    const [only] = await expectDiskParity("authority");
    expect(only).toEqual({ settled: "ok", notes: [], leaves: { "embeddings.bin": sha(encodeBinaryStore(updated())), "embeddings.json": sha(BACKUP) } });
  });

  it("P5 refuses a non-regular binary leaf and writes no JSON instead, as the disk did", async () => {
    const [only] = await expectDiskParity("nonregular");
    expect(only).toEqual({ settled: "Error: refusing to replace a non-regular binary embedding index", notes: [],
      leaves: { "embeddings.bin": "directory", "embeddings.json": sha(BACKUP) } });
  });

  it("P6 refuses a store JSON cannot serialize before creating the private directory, as the disk did", async () => {
    const [only] = await expectDiskParity("unserializable");
    expect([only!.settled.startsWith("TypeError: "), only!.settled.includes("BigInt"), only!.notes, only!.leaves]).toEqual([true, true, [], null]);
  });

  it("P7 looks, encodes, creates a missing directory and replaces in that order, and stops at the first refusal (memory only)", async () => {
    const logs = { requested: [] as string[], authority: [] as string[], nonregular: [] as string[] };
    for (const name of Object.keys(logs) as (keyof typeof logs)[]) await expectDiskParity(name, logs[name]);
    expect(logs).toEqual({
      requested: ["dir", "dir", "create", "replace .llmwiki/embeddings.bin"],
      authority: ["dir", "kind embeddings.bin", "replace .llmwiki/embeddings.bin"],
      nonregular: ["dir", "kind embeddings.bin"],
    });
  });

  it("P8 migrates a JSON overflow to binary with the notice after the replacement, and no notice when it is refused (memory only)", async () => {
    const store = overflowStore();
    const [published, refused] = [[] as string[], [] as string[]];
    const ok = memoryWritesOf(seededCopy("absent"), published);
    const failed = memoryWritesOf(seededCopy("absent"), refused, Object.assign(new Error("publication refused"), { code: "EIO" }));
    const [first] = await runSteps([{ optIn: "", store: () => store }], (one) => persistEmbeddingStoreFrom(ok.writes, one), ok.leaves, published);
    const [second] = await runSteps([{ optIn: "", store: () => store }], (one) => persistEmbeddingStoreFrom(failed.writes, one), failed.leaves, refused);
    expect([JSON.parse(first!).notes, Object.keys(JSON.parse(first!).leaves), published.slice(-2)])
      .toEqual([[NOTICE], ["embeddings.bin"], ["replace .llmwiki/embeddings.bin", `note ${NOTICE}`]]);
    expect([JSON.parse(second!).settled, JSON.parse(second!).notes, refused.at(-1)]).toEqual(["Error: publication refused", [], "replace .llmwiki/embeddings.bin"]);
  }, 60_000);
});

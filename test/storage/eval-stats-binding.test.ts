/**
 * @file test/storage/eval-stats-binding.test.ts
 * @description The evaluation snapshot as a WHOLE consumer with no project
 * directory: `collectStatsFrom` over `StatsSources`. The body exists only after
 * the snapshot was given sources of its own, so this file has NO before-edit
 * run, and agreement between the two forms of one body is not, by itself, proof
 * of what the snapshot did before the edit. The written-out figures below are
 * the independent part: they were worked out by hand from the fixtures.
 *
 * HOW IT IS BUILT. Four small projects are minted on real disk: a healthy one
 * with a binary index, one with a source selection in its configuration and a
 * corrupt binary index beside a valid JSON one, one with an index of an older
 * version, and an empty directory. The real root-taking `collectStats` answers
 * each, the text tree is copied, and the directories are removed before any
 * case runs. Embedding leaves are written from BYTES THIS FILE HOLDS and the
 * in-memory double is given those same buffers.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The source selection and scan with its markdown
 * filter, the generic page collection, the stored-embedding reader with its
 * binary authority, the frontmatter split, the character sum, the rounding,
 * the availability rule and the clock read. The doubles answer raw facts only:
 * a text, a listing, whether a path is there, a leaf's kind and bytes. No
 * count, page list, parsed store or availability verdict is handed in.
 *
 * THE CLOCK. Only `Date` is faked, in this file, so the two forms stamp the
 * same instant. Production reads the clock as it always did.
 *
 * WHAT IS NOT SHOWN. `runEval` and every caller above the snapshot, which still
 * take a project root. The doubles have no links and confine nothing: what the
 * disk does with a linked private directory is the one disk observation in the
 * last block.
 */

import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { collectStats, collectStatsFrom, type StatsSources } from "../../src/eval/stats.js";
import type { StatsResult } from "../../src/eval/types.js";
import type { LegacyLocalReads } from "../../src/storage/legacy-local-reads.js";
import { encodeBinaryStore } from "../../src/utils/embeddings-binary.js";
import type { StoredEmbeddingReads } from "../../src/utils/embeddings-storage.js";
import { binaryFixture } from "../fixtures/binary-embedding-store.js";
import { tempRootTracker } from "../temp-roots.js";
import { enoent, heldText, mintCopied, mintOnceThenRemove, unasked, writeFiles, type Copy, type Minted } from "./copied-project.js";
import { lintSourcesOver, NO_ENTITIES } from "./lint-sources-doubles.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "eval-stats-";
const PRIVATE_DIR = ".llmwiki";
const AT = "2026-03-04T05:06:07.000Z";
const LATER = "2026-03-04T09:00:00.000Z";
const NAMES = ["healthy", "configured", "olderIndex", "empty"] as const;
type Name = (typeof NAMES)[number];
/** One project: its text files, and its embedding leaves as the bytes written. */
interface Project { files: Record<string, string>; leaves: Record<string, Buffer> }
const page = (body: string): string => `---\ntitle: T\n---\n${body}`;

const PROJECTS: Record<Name, Project> = {
  healthy: {
    files: {
      "sources/a.md": "a", "sources/b.md": "b", "sources/notes.txt": "n", "sources/deep/x.md": "x",
      "wiki/concepts/alpha.md": page("0123456789"), "wiki/queries/asked.md": "thirteen char",
      "wiki/concepts/notes.txt": "not a page", "wiki/entities/e.md": page("outside the generic scope"),
    },
    leaves: { "embeddings.bin": encodeBinaryStore(binaryFixture()) },
  },
  configured: {
    files: {
      ".llmwiki/config.json": JSON.stringify({ version: 1, sources: { recursive: true, exclude: ["deep/skip"] } }),
      "sources/a.md": "a", "sources/top.txt": "t", "sources/deep/x.md": "x", "sources/deep/more/z.md": "z", "sources/deep/skip/y.md": "y",
      "wiki/concepts/crlf.md": "---\r\ntitle: T\r\n---\r\nseven77",
    },
    leaves: { "embeddings.bin": Buffer.from("bad"), "embeddings.json": Buffer.from(JSON.stringify(binaryFixture())) },
  },
  olderIndex: {
    files: { "wiki/concepts/one.md": page("a"), "wiki/concepts/two.md": page("bb"), "wiki/queries/three.md": page("cc") },
    leaves: { "embeddings.json": Buffer.from(JSON.stringify({ version: 1, entries: [] })) },
  },
  empty: { files: {}, leaves: {} },
};

/** Worked out by hand from the fixtures above; `healthy` carries NO availability key. */
const EXPECTED: Record<Name, StatsResult> = {
  healthy: { timestamp: AT, sourceCount: 2, pageCount: 2, totalWikiChars: 23, embeddingCount: 2, chunkEmbeddingCount: 1, avgPageLengthChars: 12 },
  configured: { timestamp: AT, sourceCount: 3, pageCount: 1, totalWikiChars: 7, embeddingCount: 0, chunkEmbeddingCount: 0, avgPageLengthChars: 7, embeddingsAvailable: false },
  olderIndex: { timestamp: AT, sourceCount: 0, pageCount: 3, totalWikiChars: 5, embeddingCount: 0, chunkEmbeddingCount: 0, avgPageLengthChars: 2, embeddingsAvailable: false },
  empty: { timestamp: AT, sourceCount: 0, pageCount: 0, totalWikiChars: 0, embeddingCount: 0, chunkEmbeddingCount: 0, avgPageLengthChars: 0, embeddingsAvailable: false },
};
const DEGRADED_HEALTHY: StatsResult = { ...EXPECTED.healthy, embeddingCount: 0, chunkEmbeddingCount: 0, embeddingsAvailable: false };

const tracker = tempRootTracker();
const minted = new Map<Name, Minted<StatsResult>>();
const linkRoots: string[] = [];
/** What the disk snapshot did where the private directory was a link out of the project: its answer, or the rejection's name. */
const linked: { answer?: StatsResult | string } = {};

/** Write the text files, then make the private directory and write each leaf, when the project has any. */
async function seeded(root: string, project: Project): Promise<void> {
  await writeFiles(root, project.files);
  if (Object.keys(project.leaves).length === 0) return;
  await mkdir(path.join(root, PRIVATE_DIR), { recursive: true });
  for (const [name, bytes] of Object.entries(project.leaves)) await writeFile(path.join(root, PRIVATE_DIR, name), bytes);
}

/** A project with one source whose private directory is a link to another directory's, holding a healthy index. */
async function mintLinked(): Promise<void> {
  const outside = await tracker.create(PREFIX, { real: true });
  await seeded(outside, { files: {}, leaves: PROJECTS.healthy.leaves });
  const escaping = await tracker.create(PREFIX, { real: true });
  await seeded(escaping, { files: { "sources/a.md": "a" }, leaves: {} });
  await symlink(path.join(outside, PRIVATE_DIR), path.join(escaping, PRIVATE_DIR));
  linked.answer = await collectStats(escaping).catch((error: Error) => error.name);
  linkRoots.push(outside, escaping);
}

beforeAll(() => { setSystemTime(new Date(AT)); });
beforeEach(() => { setSystemTime(new Date(AT)); });
afterAll(() => { setSystemTime(); });
mintOnceThenRemove(tracker, async () => {
  for (const name of NAMES) minted.set(name, await mintCopied(tracker, PREFIX, (root) => seeded(root, PROJECTS[name]), collectStats));
  await mintLinked();
});

function mintedOf(name: Name): Minted<StatsResult> {
  const one = minted.get(name);
  if (one === undefined) throw new Error(`${name} was not minted`);
  return one;
}

/** The scan's two reads over the copy: the configuration text, and the sources directory's listings. */
function scanReadsOver(copy: Copy, log: string[]): LegacyLocalReads {
  const listingUnder = (relDir: string) => async (relative: string) => {
    const held = copy.listings.get(path.posix.join(relDir, relative));
    if (held === undefined) throw enoent();
    return held;
  };
  return {
    readText: async (rel) => { log.push(`config ${rel}`); return heldText(copy, rel); },
    realDirectory: async (relDir) => { log.push(`sources ${relDir}`); return copy.listings.has(relDir) ? { listEntries: listingUnder(relDir) } : null; },
    exists: unasked("sourceReads.exists"), statNoFollow: unasked("sourceReads.statNoFollow"), listNames: unasked("sourceReads.listNames"),
    locate: unasked("sourceReads.locate"), readConfinedFile: unasked("sourceReads.readConfinedFile"), readConfinedPage: unasked("sourceReads.readConfinedPage"),
  };
}

/** The three raw facts of the private directory over held bytes; `null` means the copy has no private directory. */
function embeddingsOver(leaves: Record<string, Buffer> | null, log: string[]): StoredEmbeddingReads {
  return {
    resolvePrivateDir: async () => { log.push("private"); return leaves === null ? null : "memory:private"; },
    leafKind: async (_dir, name) => (leaves?.[name] === undefined ? "absent" : "regular"),
    readLeafBytes: async (_dir, name, maxBytes) => {
      const bytes = leaves?.[name];
      if (bytes === undefined) throw enoent();
      return bytes.length > maxBytes ? null : bytes;
    },
  };
}

/** The snapshot's sources over one project's copy and held leaves. Every first-step call is logged. */
function sourcesOver(name: Name, log: string[] = []): StatsSources {
  const project = mintedOf(name);
  const pages = lintSourcesOver({ ...project, onDisk: { real: project.dir } }, log, NO_ENTITIES).pages;
  return {
    sourceReads: scanReadsOver(project.copy, log),
    pages: { ...pages, exists: async (rel) => { log.push(`exists ${rel}`); return pages.exists(rel); } },
    embeddings: embeddingsOver(project.copy.listings.has(PRIVATE_DIR) ? PROJECTS[name].leaves : null, log),
  };
}

describe("the evaluation snapshot over copies and held bytes, with the directories gone", () => {
  it("T1 runs after every minting directory was removed", () => {
    expect([minted.size, linkRoots.length]).toEqual([NAMES.length, 2]);
    for (const root of [...NAMES.map((name) => mintedOf(name).dir), ...linkRoots]) expectMintingDirectoryRemoved(root, PREFIX);
  });

  it("T2 answers every project exactly as the disk snapshot did", async () => {
    for (const name of NAMES) expect([name, await collectStatsFrom(sourcesOver(name))]).toStrictEqual([name, mintedOf(name).onDisk]);
  });

  it("T3 gives the figures worked out by hand, on disk and in memory", async () => {
    for (const name of NAMES) {
      expect([name, mintedOf(name).onDisk]).toStrictEqual([name, EXPECTED[name]]);
      expect([name, await collectStatsFrom(sourcesOver(name))]).toStrictEqual([name, EXPECTED[name]]);
    }
  });

  it("T4 leaves the availability key out of a healthy snapshot and sets it false in every degraded one", async () => {
    const keys = async (name: Name): Promise<string[]> => Object.keys(await collectStatsFrom(sourcesOver(name)));
    const healthy = ["timestamp", "sourceCount", "pageCount", "totalWikiChars", "embeddingCount", "chunkEmbeddingCount", "avgPageLengthChars"];
    expect(await keys("healthy")).toEqual(healthy);
    for (const name of ["configured", "olderIndex", "empty"] as const) expect([name, await keys(name)]).toEqual([name, [...healthy, "embeddingsAvailable"]]);
  });

  it("T5 starts the three reads together and in order: the sources, then the pages, then the embeddings", async () => {
    const log: string[] = [];
    await collectStatsFrom(sourcesOver("healthy", log));
    expect(log.slice(0, 3)).toEqual(["config .llmwiki/config.json", "exists wiki/concepts", "private"]);
    expect(log.filter((call) => call.startsWith("page ")).sort()).toEqual(["page wiki/concepts/alpha.md", "page wiki/queries/asked.md"]);
  });

  it("T6 reads the clock once the reads are in, not when the snapshot was asked for", async () => {
    const sources = sourcesOver("healthy");
    const readText = sources.pages.readText;
    sources.pages.readText = async (rel) => { setSystemTime(new Date(LATER)); return readText(rel); };
    expect(await collectStatsFrom(sources)).toStrictEqual({ ...EXPECTED.healthy, timestamp: LATER });
  });

  it("T7 catches an embedding refusal and reports the index unavailable, with the other figures intact", async () => {
    const sources = sourcesOver("healthy");
    sources.embeddings.resolvePrivateDir = async () => { throw new Error("planted private-directory refusal"); };
    expect(await collectStatsFrom(sources)).toStrictEqual(DEGRADED_HEALTHY);
  });

  it("T8 reports the index unavailable when the binary leaf is over its cap or cannot be read", async () => {
    const [overCap, unreadable] = [sourcesOver("healthy"), sourcesOver("healthy")];
    overCap.embeddings.readLeafBytes = async () => null;
    unreadable.embeddings.readLeafBytes = async () => { throw new Error("planted leaf failure"); };
    expect([await collectStatsFrom(overCap), await collectStatsFrom(unreadable)]).toStrictEqual([DEGRADED_HEALTHY, DEGRADED_HEALTHY]);
  });

  it("T9 rejects with the error of a sources listing that fails, and refuses a configuration that cannot be read", async () => {
    const failure = new Error("planted listing failure");
    const [listing, config] = [sourcesOver("healthy"), sourcesOver("healthy")];
    listing.sourceReads.realDirectory = async () => ({ listEntries: async () => { throw failure; } });
    config.sourceReads.readText = async () => { throw new Error("planted configuration failure"); };
    await expect(collectStatsFrom(listing)).rejects.toBe(failure);
    await expect(collectStatsFrom(config)).rejects.toThrow("Invalid .llmwiki/config.json: Error: planted configuration failure");
  });

  it("T10 rejects with the error of a page directory that cannot be listed and of a page that cannot be read", async () => {
    const [unlisted, unread] = [new Error("planted page listing failure"), new Error("planted page read failure")];
    const [listing, reading] = [sourcesOver("healthy"), sourcesOver("healthy")];
    listing.pages.listNames = async () => { throw unlisted; };
    reading.pages.readText = async () => { throw unread; };
    await expect(collectStatsFrom(reading)).rejects.toBe(unread);
    await expect(collectStatsFrom(listing)).rejects.toBe(unlisted);
  });
});

describe("what a linked private directory does, from the disk snapshot's answer only", () => {
  it("K1 the disk snapshot did not throw: it counted the source and reported the index unavailable", () => {
    expect(linked.answer).toStrictEqual({ ...EXPECTED.empty, sourceCount: 1 });
  });
});

/**
 * @file test/storage/embedding-page-collection-binding.test.ts
 * @description The embedding PAGE COLLECTORS, WHOLE, over storage held in memory:
 * `collectEligibleLivePagesFrom` (the reserved scan through
 * `collectNamespacedPageRecordsFrom`, the default profile's stop before any
 * entity scan, then typed pages through the existing `collectEntityPagesFrom`,
 * gated by retrieval eligibility and profile validity) and
 * `requestedPagesExistenceFrom` (which directory owns an id, and what present,
 * absent and unknown mean). They exist only after the collectors were given
 * bodies of their own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Two projects are minted on real disk, once: a default-profile
 * project and a typed one. The profile is caller input, built as a literal
 * `LoadedProfile` (the incumbent `embeddings-load.test.ts` pattern), and both
 * sides receive the same one. Each project's OWN disk ask runs its steps through
 * the real root forms and settles each step EXACTLY ONCE: a value as its JSON,
 * a refusal as its name and message. The minting directories are removed before
 * any case runs. The memory side runs the same steps through the bound bodies
 * over the copied tree; the collectors only read, so the copy is the starting
 * state. Collected pages carry their texts, chunks and hashes, so parity covers
 * them byte for byte.
 *
 * WHAT THE MECHANISMS DECIDE. Only physical facts: whether the project and a
 * directory resolve (inside the project), a directory's names in listing order,
 * an entry's text or its refusal, and whether a path is a regular file. The
 * entity scans reuse the shared `entityScansOf` double. Every injected fault is
 * MEMORY ONLY, with no disk twin here.
 *
 * NOT SHOWN HERE, AND KEPT LOCAL TO THE DISK MECHANISMS: links (escaping pages,
 * linked directories), real access refusals, handle-bound reads and the
 * fs-level failures `test/storage/residual-reads.test.ts` injects. The
 * embedding writer, the scoped planner, the refresh, the provider and the lock
 * are not run here.
 */

import path from "node:path";
import { describe, expect, it } from "bun:test";
import {
  collectEligibleLivePages, collectEligibleLivePagesFrom, requestedPagesExistence, requestedPagesExistenceFrom,
} from "../../src/utils/embeddings-collect.js";
import type { EmbeddingPageReads } from "../../src/utils/embeddings-pages.js";
import type { LegacyLocalEntityScans } from "../../src/storage/legacy-local-reads.js";
import type { LoadedProfile } from "../../src/profile/types.js";
import { entityScansOf, mintCopied, writeFiles, type Copy } from "./copied-project.js";
import { mintEachScenario, settleInOrder } from "./scenario-mint.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "embedding-page-collection-binding-";
const MEM_ROOT = "/memory/project";
const loaded = (profile: unknown): LoadedProfile => ({ profile: profile as LoadedProfile["profile"], loadedFrom: null, digest: "" });
const DEFAULT = loaded({ schemaVersion: 1, profileId: "default", entities: {} });
/** `papers` opt in to both surfaces and require a venue; `secrets` opt out of both, so they are never collected. */
const TYPED = loaded({
  schemaVersion: 1, profileId: "embed-pages-witness",
  entities: {
    papers: { directory: "wiki/papers", requiredFields: ["venue"], fields: { venue: { type: "string" } },
      retrieval: { includeInSearch: true, includeInContext: true } },
    secrets: { directory: "wiki/secrets", retrieval: { includeInSearch: false, includeInContext: false } },
  },
});
const ALPHA = "---\ntitle: Alpha\nsummary: First idea\n---\nAlpha body paragraph one.\n\nAlpha body paragraph two.\n";
const RESERVED_SEED = {
  "wiki/concepts/alpha.md": ALPHA,
  "wiki/concepts/orphan.md": "---\ntitle: Orphan\norphaned: true\n---\nGone.\n",
  "wiki/concepts/untitled.md": "---\nsummary: no title\n---\nNo title.\n",
  "wiki/concepts/notes.txt": "not a page",
  "wiki/queries/question.md": "---\ntitle: Question\n---\nWhat is alpha?\n",
};
const TYPED_SEED = {
  "wiki/concepts/alpha.md": ALPHA,
  "wiki/papers/p-one.md": "---\ntitle: Paper One\nvenue: NeurIPS\nsummary: About one\n---\nPaper one body.\n",
  "wiki/papers/p-bad.md": "---\ntitle: Paper Bad\n---\nMissing its venue.\n",
  "wiki/papers/p-two.md": "---\ntitle: Paper Two\nvenue: ICML\n---\nPaper two body.\n",
  "wiki/secrets/s-one.md": "---\ntitle: Secret\n---\nPRIVATE body.\n",
};

/** The two consumers, by root on disk or bound in memory. */
interface Api {
  collect(profile: LoadedProfile): Promise<unknown>;
  existence(profile: LoadedProfile, ids: string[]): Promise<Map<string, string>>;
}
type Step = (api: Api) => Promise<unknown>;
const exist = (profile: LoadedProfile, ids: string[]): Step => async (api) => [...(await api.existence(profile, ids))];

const SCENARIOS = {
  reserved: { seed: RESERVED_SEED, steps: [(api) => api.collect(DEFAULT),
    exist(DEFAULT, ["concepts/alpha", "concepts/gone", "queries/question", "bogus", "papers/p-one"])] as Step[] },
  typed: { seed: TYPED_SEED, steps: [(api) => api.collect(TYPED),
    exist(TYPED, ["papers/p-one", "papers/p-none", "secrets/s-one", "notes/x", "concepts/alpha", "papers/p-bad"])] as Step[] },
};
type Name = keyof typeof SCENARIOS;

/** Run steps in order, settling each exactly once. */
async function runSteps(steps: Step[], api: Api): Promise<string[]> {
  return settleInOrder(steps, (step) => step(api));
}

const minted = mintEachScenario(Object.keys(SCENARIOS) as Name[], (tracker, name) =>
  mintCopied(tracker, PREFIX, (root) => writeFiles(root, SCENARIOS[name].seed), (root) => runSteps(SCENARIOS[name].steps, {
    collect: (profile) => collectEligibleLivePages(root, profile),
    existence: (profile, ids) => requestedPagesExistence(root, profile, ids),
  })));

/** Faults with no disk twin. */
interface Faults { noProject?: boolean; escapes?: string; unlistable?: string; unreadable?: string; statCodes?: Record<string, string> }

/** Page reads over a copied tree; every call is recorded to `log` first. */
function memoryPageReadsOf(copy: Copy, log: string[], faults: Faults = {}): EmbeddingPageReads {
  const relOf = (locator: string): string => path.posix.relative(MEM_ROOT, locator);
  const failure = (code: string): Error => Object.assign(new Error(code), { code });
  return {
    projectDirectory: async () => { log.push("project"); return faults.noProject ? null : MEM_ROOT; },
    confinedDirectory: async (project, relDir) => {
      log.push(`dir ${relDir}`);
      return copy.listings.has(relDir) && relDir !== faults.escapes ? path.posix.join(project, relDir) : null;
    },
    listNames: async (directory) => {
      log.push(`list ${relOf(directory)}`);
      if (relOf(directory) === faults.unlistable) throw failure("EIO");
      return copy.listings.get(relOf(directory))!.map((entry) => entry.name);
    },
    readConfinedEntry: async (directory, name) => {
      const rel = `${relOf(directory)}/${name}`;
      log.push(`read ${rel}`);
      const text = rel === faults.unreadable ? undefined : copy.files.get(rel);
      return text === undefined ? { dropped: "unreadable" } : { content: text };
    },
    isRegularFile: async (relPath) => {
      log.push(`stat ${relPath}`);
      const code = faults.statCodes?.[relPath];
      if (code !== undefined) throw failure(code);
      if (copy.files.has(relPath)) return true;
      if (copy.listings.has(relPath)) return false;
      throw failure("ENOENT");
    },
  };
}

/** The bound bodies over memory reads and the shared entity-scan double. */
function memoryApi(copy: Copy, log: string[], faults: Faults = {}, entities?: LegacyLocalEntityScans): Api {
  const pages = memoryPageReadsOf(copy, log, faults);
  const scans = entities ?? entityScansOf(copy, MEM_ROOT, (call) => log.push(call));
  return {
    collect: (profile) => collectEligibleLivePagesFrom({ pages, entities: scans }, profile),
    existence: (profile, ids) => requestedPagesExistenceFrom(pages, profile, ids),
  };
}

/** Run `name` in memory and require the disk's settled outcomes. */
async function expectDiskParity(name: Name): Promise<string[]> {
  const outcomes = await runSteps(SCENARIOS[name].steps, memoryApi(minted[name]!.copy, []));
  expect(outcomes).toEqual(minted[name]!.onDisk);
  return outcomes;
}

const idsOf = (outcome: string): string[] => (JSON.parse(outcome) as { pageId: string }[]).map((page) => page.pageId);

describe("the embedding page collectors over copied projects, with every minting directory gone", () => {
  it("C1 runs after every minting directory was removed", () => {
    for (const one of Object.values(minted)) expectMintingDirectoryRemoved(one!.dir, PREFIX);
  });

  it("C2 collects reserved pages only for the default profile, gated and hashed exactly as the disk did", async () => {
    const [collected, existence] = await expectDiskParity("reserved");
    expect(idsOf(collected!).sort()).toEqual(["concepts/alpha", "queries/question"]);
    expect(JSON.parse(collected!)[0]).toMatchObject({ title: "Alpha", summary: "First idea", embeddingText: "Alpha\n\nFirst idea" });
    expect(JSON.parse(existence!)).toEqual([["concepts/alpha", "present"], ["concepts/gone", "absent"], ["queries/question", "present"],
      ["bogus", "absent"], ["papers/p-one", "absent"]]);
  });

  it("C3 appends valid typed pages after reserved ones, never collecting both-false or profile-invalid pages, as the disk did", async () => {
    const [collected, existence] = await expectDiskParity("typed");
    const ids = idsOf(collected!);
    expect([ids[0], ids.slice(1).sort()]).toEqual(["concepts/alpha", ["papers/p-one", "papers/p-two"]]);
    expect(collected).not.toContain("PRIVATE");
    expect(JSON.parse(existence!)).toEqual([["papers/p-one", "present"], ["papers/p-none", "absent"], ["secrets/s-one", "present"],
      ["notes/x", "absent"], ["concepts/alpha", "present"], ["papers/p-bad", "present"]]);
  });

  it("C4 stops the default profile before any entity scan (memory only)", async () => {
    const touched: string[] = [];
    const refusing: LegacyLocalEntityScans = { openEntityDirectory: async (relDir) => { touched.push(relDir); throw new Error("entity scan reached"); } };
    const collected = await memoryApi(minted.typed!.copy, [], {}, refusing).collect(DEFAULT);
    expect([(collected as { pageId: string }[]).map((page) => page.pageId), touched]).toEqual([["concepts/alpha"], []]);
  });

  it("C5 skips an unresolved project, an escaping or unlistable directory and an unreadable entry (memory only)", async () => {
    const copy = minted.reserved!.copy;
    const collect = async (faults: Faults) => ((await memoryApi(copy, [], faults).collect(DEFAULT)) as { pageId: string }[]).map((page) => page.pageId).sort();
    expect(await collect({ noProject: true })).toEqual([]);
    expect(await collect({ escapes: "wiki/concepts" })).toEqual(["queries/question"]);
    expect(await collect({ unlistable: "wiki/queries" })).toEqual(["concepts/alpha"]);
    expect(await collect({ unreadable: "wiki/concepts/alpha.md" })).toEqual(["queries/question"]);
  });

  it("C6 answers unknown for any failure but a missing path or parent, and absent for a non-file (memory only)", async () => {
    const log: string[] = [];
    const statCodes = { "wiki/concepts/alpha.md": "EACCES", "wiki/queries/question.md": "ENOTDIR", "wiki/concepts/x.md": "EIO" };
    const answers = await memoryApi(minted.reserved!.copy, log, { statCodes }).existence(DEFAULT, ["concepts/alpha", "queries/question", "concepts/x"]);
    expect([...answers]).toEqual([["concepts/alpha", "unknown"], ["queries/question", "absent"], ["concepts/x", "unknown"]]);
    const directory = await memoryApi({ ...minted.reserved!.copy, listings: new Map([["wiki/concepts/dir.md", []]]) }, []).existence(DEFAULT, ["concepts/dir"]);
    expect([...directory]).toEqual([["concepts/dir", "absent"]]);
  });
});

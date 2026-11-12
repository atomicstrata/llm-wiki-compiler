/**
 * @file test/storage/link-resolution-binding.test.ts
 * @description The interlink PLANNER, WHOLE, over reads held in memory:
 * `resolveLinksFrom` lists the concept titles (orphaned, untitled and non-`.md`
 * entries excluded), plans the outbound pass over the changed pages, then the
 * inbound pass over every indexed page except the new ones, and returns one
 * write per rewritten page: a page planned by both passes appears ONCE, at its
 * outbound position, with the body the inbound pass made from the page as it
 * was read (L8 shows this with two different bodies). It exists only after the planner was given a body of
 * its own, so this file has NO before-edit run. Applying the writes
 * (`resolveAndApplyLinks`) stays root-bound and is not run here.
 *
 * HOW IT IS BUILT. Two projects are minted on real disk, once, and each tree is
 * copied BEFORE its disk ask (`mintCopiedBeforeAsk`), so the copy is the seed
 * whatever the ask does. Each project's OWN disk ask runs its steps through the
 * real root form `resolveLinks` and settles each step EXACTLY ONCE: the planned
 * writes, or the error. The minting directories are removed before any case
 * runs. Before every memory replay the copy is checked LITERALLY against the
 * seed. The memory side then runs the same steps through the bound body over
 * the copy. The expected bodies are built from the SEED texts, never from what
 * either side returned.
 *
 * WHAT IS MEMORY ONLY. The read log and its order, a dropped page and a
 * rejecting listing. Links, real confinement and access refusals stay with the
 * incumbent resolver suites; the output line is ambient and not compared.
 */

import { describe, expect, it } from "bun:test";
import { resolveLinks, resolveLinksFrom } from "../../src/compiler/resolver.js";
import type { LegacyLocalReads } from "../../src/storage/legacy-local-reads.js";
import { CONCEPTS_DIR } from "../../src/utils/constants.js";
import { mintCopiedBeforeAsk, unasked, writeFiles, type Copy } from "./copied-project.js";
import { expectMintsRemovedThenSeeded, mintEachScenario, settleInOrder } from "./scenario-mint.js";

const PREFIX = "link-resolution-binding-";
const MEM_ROOT = "/memory/project";
const page = (slug: string): string => `${CONCEPTS_DIR}/${slug}`;
const ALPHA_TEXT = "---\ntitle: Alpha\n---\nBeta costs $$ and `Beta` stays code; see Delta.\n";
const BETA_TEXT = "---\ntitle: Beta\n---\nAlpha comes first.\n";
const SEED = {
  [page("alpha.md")]: ALPHA_TEXT,
  [page("beta.md")]: BETA_TEXT,
  [page("delta.md")]: "---\ntitle: Delta\n---\nNothing to link here.\n",
  [page("gamma.md")]: "---\ntitle: Gamma\norphaned: true\n---\nAlpha and Beta.\n",
  [page("untitled.md")]: "---\nsummary: None\n---\nAlpha.\n",
  [page("notes.txt")]: "Alpha and Beta.\n",
};
/**
 * The planned writes, built from the seed texts: the first linkable mention gets
 * its link, code and `$$` stay verbatim. Outbound links alpha to every other
 * title it mentions (Beta and Delta); inbound for a new Beta links only Beta.
 */
const ALPHA_INBOUND = { namespace: "concepts", slug: "alpha", body: ALPHA_TEXT.replace("Beta costs", "[[beta|Beta]] costs") };
const ALPHA_OUTBOUND = { ...ALPHA_INBOUND, body: ALPHA_INBOUND.body.replace("see Delta.", "see [[delta|Delta]].") };
const BETA_WRITE = { namespace: "concepts", slug: "beta", body: BETA_TEXT.replace("Alpha comes", "[[alpha|Alpha]] comes") };

interface Step { changed: string[]; created: string[] }
type Plan = (step: Step) => Promise<unknown>;
const STEPS: Step[] = [
  { changed: ["alpha"], created: [] },
  { changed: [], created: ["beta"] },
  { changed: ["beta"], created: ["beta"] },
  { changed: [], created: ["ghost"] },
  { changed: ["alpha", "beta"], created: ["beta"] },
];
const SCENARIOS = {
  wiki: { seed: (root: string) => writeFiles(root, SEED), steps: STEPS },
  bare: { seed: (root: string) => writeFiles(root, { "README.md": "x" }), steps: [{ changed: ["alpha"], created: ["alpha"] }] },
};
type Name = keyof typeof SCENARIOS;

/** Run steps in order, settling each exactly once. */
async function runSteps(steps: Step[], plan: Plan): Promise<string[]> {
  return settleInOrder(steps, plan);
}

const minted = mintEachScenario(Object.keys(SCENARIOS) as Name[], (tracker, name) =>
  mintCopiedBeforeAsk(tracker, PREFIX, SCENARIOS[name].seed,
    (root) => runSteps(SCENARIOS[name].steps, (step) => resolveLinks(root, step.changed, step.created))));

/** `name`'s copy, after requiring LITERALLY that it holds the seed: the six concept entries and their texts, or no concept directory. */
function seededCopy(name: Name): Copy {
  const copy = minted[name]!.copy;
  const names = copy.listings.get(CONCEPTS_DIR)?.map((one) => one.name).sort() ?? null;
  expect(names).toEqual(name === "wiki" ? ["alpha.md", "beta.md", "delta.md", "gamma.md", "notes.txt", "untitled.md"] : null);
  if (name === "wiki") expect(Object.keys(SEED).map((rel) => copy.files.get(rel))).toEqual(Object.values(SEED));
  return copy;
}

/** Faults with no disk twin: a listing that rejects, and pages the confined read drops. */
interface Faults { listing?: Error; dropped?: string[] }

/** The raw legacy-local reads over a copied tree, POSIX project-relative; every read is logged, the unasked members throw. */
function memoryReadsOf(copy: Copy, log: string[], faults: Faults = {}): LegacyLocalReads {
  return {
    exists: async (relPath) => { log.push(`exists ${relPath}`); return copy.listings.has(relPath) || copy.files.has(relPath); },
    listNames: async (relDir) => {
      log.push(`list ${relDir}`);
      if (faults.listing) throw faults.listing;
      return copy.listings.get(relDir)!.map((one) => one.name);
    },
    readConfinedPage: async (relDir, slug) => {
      log.push(`read ${slug}`);
      const text = copy.files.get(`${relDir}/${slug}.md`);
      return faults.dropped?.includes(slug) || text === undefined ? { dropped: "escapes-dir" } : { content: text };
    },
    locate: (relPath) => `${MEM_ROOT}/${relPath}`,
    readText: unasked("readText"), statNoFollow: unasked("statNoFollow"), realDirectory: unasked("realDirectory"), readConfinedFile: unasked("readConfinedFile"),
  };
}

/** Run `name` in memory from its seeded copy and require the disk's settled outcomes. */
async function expectDiskParity(name: Name, log: string[] = []): Promise<unknown[]> {
  const reads = memoryReadsOf(seededCopy(name), log);
  const outcomes = await runSteps(SCENARIOS[name].steps, (step) => resolveLinksFrom(reads, step.changed, step.created));
  expect(outcomes).toEqual(minted[name]!.onDisk);
  return outcomes.map((outcome) => JSON.parse(outcome));
}

describe("the interlink planner over copied projects, with every minting directory gone", () => {
  it("L1 runs after every minting directory was removed, on copies holding exactly the seed", () => {
    expectMintsRemovedThenSeeded(minted, PREFIX, Object.keys(SCENARIOS) as Name[], seededCopy);
  });

  it("L2 links a changed page outbound to every title it mentions, leaving code and $$ verbatim, as the disk did", async () => {
    const [outbound] = await expectDiskParity("wiki");
    expect(outbound).toEqual([ALPHA_OUTBOUND]);
  });

  it("L3 scans the older pages inbound for a new title and skips the new page itself, as the disk did", async () => {
    const [, inbound] = await expectDiskParity("wiki");
    expect(inbound).toEqual([ALPHA_INBOUND]);
  });

  it("L4 plans outbound first, then inbound, and never rewrites an orphaned, untitled or non-markdown entry, as the disk did", async () => {
    const [, , both, none] = await expectDiskParity("wiki");
    expect([both, none]).toEqual([[BETA_WRITE, ALPHA_INBOUND], []]);
  });

  it("L5 plans nothing, reading nothing past the existence check, where there is no concept directory", async () => {
    const log: string[] = [];
    expect(await expectDiskParity("bare", log)).toEqual([[]]);
    expect(log).toEqual([`exists ${CONCEPTS_DIR}`]);
  });

  it("L6 lists and reads every listed page once, in listing order; the outbound and inbound passes reuse those reads (memory only)", async () => {
    const log: string[] = [];
    const copy = seededCopy("wiki");
    await resolveLinksFrom(memoryReadsOf(copy, log), ["beta"], ["beta"]);
    const listed = copy.listings.get(CONCEPTS_DIR)!.map((one) => one.name).filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3));
    expect(log).toEqual([`exists ${CONCEPTS_DIR}`, `list ${CONCEPTS_DIR}`, ...listed.map((slug) => `read ${slug}`)]);
  });

  it("L8 plans a page in both passes once, at its outbound position, with the inbound body, as the disk did", async () => {
    const [, , , , twice] = await expectDiskParity("wiki");
    // Outbound plans the changed pages in listing order; inbound then replaces alpha's write in place.
    const outboundOrder = seededCopy("wiki").listings.get(CONCEPTS_DIR)!.map((one) => one.name).filter((file) => file === "alpha.md" || file === "beta.md");
    expect(ALPHA_INBOUND.body).not.toBe(ALPHA_OUTBOUND.body);
    expect(twice).toEqual(outboundOrder.map((file) => (file === "alpha.md" ? ALPHA_INBOUND : BETA_WRITE)));
  });

  it("L7 keeps a dropped page out of the index and passes a listing failure on raw (memory only)", async () => {
    const copy = seededCopy("wiki");
    expect(await resolveLinksFrom(memoryReadsOf(copy, [], { dropped: ["beta"] }), [], ["beta"])).toEqual([]);
    const refusal = Object.assign(new Error("EACCES: listing refused"), { code: "EACCES" });
    await expect(resolveLinksFrom(memoryReadsOf(copy, [], { listing: refusal }), ["alpha"], [])).rejects.toBe(refusal);
  });
});

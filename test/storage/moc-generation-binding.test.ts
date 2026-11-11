/**
 * @file test/storage/moc-generation-binding.test.ts
 * @description The WHOLE Map of Content generator, `generateMOCFrom`, with no
 * project directory, from the concept listing through publication. It exists
 * only after the generator was given sources of its own, so this file has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. Two projects are minted on real disk, once: a wiki whose
 * concepts carry tags, a missing title, no tags, an orphan flag and an empty
 * file; and a project that has a `wiki` directory but NO concept directory.
 * The real `generateMOC(root)` writes each Map of Content, the text is read
 * back, the trees are copied into memory, and the directories are removed
 * before any case runs. Each case then runs the root-free body over the copy
 * and CAPTURES what it publishes. See `copied-project.ts`.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The whole generator body: the listing and its
 * failure rule, the `.md` filter, each page's parse, the empty and orphaned
 * exclusions, the title fallback, the grouping, both sorts and the rendering.
 * The inputs are raw page texts and the directory's listing. The Map of
 * Content the disk generation wrote is in each copy and is read by NOTHING
 * here: the doubles list and read the concept directory only, and M5 shows it.
 *
 * WHAT IS COMPARED. The captured text against the text the disk generation
 * wrote, byte for byte. NOTHING is normalized: the page has no clock field.
 *
 * WHAT A CAPTURED WRITE SHOWS, AND WHAT IT DOES NOT. It shows which text the
 * generator hands to publication, once and after every read, and that a
 * publication which rejects rejects the generation. It shows NOTHING about the
 * disk writer: atomic replacement, confinement of the write, durability,
 * locking or recovery. `compile-derived-confine.test.ts` shows the writer's
 * confinement on disk; `obsidian.test.ts` shows ordinary generation on disk.
 *
 * DROPPED READS. The read answers a fact and the BODY owns what it means: it
 * warns once, naming the bare `<slug>.md` and the read's reason, and leaves the
 * page out. M7 runs that policy in memory over a dropped fact a double hands
 * back. A double cannot show what makes a real read drop, so M9 is ONE real
 * disk case: a concept page that is a link to a file outside the project. It
 * shows that exact path through the default disk binding (the page is dropped,
 * warned about once, and none of the outside file's text reaches the page) and
 * nothing wider: no race, no durability, no locking, no other kind of link.
 *
 * The doubles are not a hosted store, not an access-control layer and not
 * `ProjectStore`.
 */

import { readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import type { ConfinedReadResult } from "../../src/compiler/confined-wiki-read.js";
import { generateMOC, generateMOCFrom, type MocGenerationSources } from "../../src/compiler/obsidian.js";
import { CONCEPTS_DIR, MOC_FILE, QUERIES_DIR } from "../../src/utils/constants.js";
import * as output from "../../src/utils/output.js";
import { tempRootTracker } from "../temp-roots.js";
import {
  captureGeneration, expectRemovedDefaultCopies, mintCopied, mintOnceThenRemove, pageScanOf, ranGeneration, writeFiles,
  type Copy, type Generation, type Minted,
} from "./copied-project.js";

const PREFIX = "moc-generation-";
const page = (frontmatter: string): string => `---\n${frontmatter}\n---\n\nBody.\n`;

const tracker = tempRootTracker();
let wiki: Minted<string>;
let bare: Minted<string>;

/**
 * Six concept files and one that is not a page. Two tags, one of them shared;
 * titles whose order differs from their slugs' order; a page with no title; a
 * page with no tags; an orphaned page; an empty file.
 */
function seedWiki(root: string): Promise<void> {
  return writeFiles(root, {
    [`${CONCEPTS_DIR}/zeta.md`]: page("title: Alpha Tool\ntags: [tools, ml]"),
    [`${CONCEPTS_DIR}/alpha.md`]: page("title: Zed Tool\ntags: [tools]"),
    [`${CONCEPTS_DIR}/beta.md`]: page("tags: [ml]"),
    [`${CONCEPTS_DIR}/plain.md`]: page("title: Plain"),
    [`${CONCEPTS_DIR}/gone.md`]: page("title: Gone\norphaned: true\ntags: [tools]"),
    [`${CONCEPTS_DIR}/empty.md`]: "", [`${CONCEPTS_DIR}/notes.txt`]: "Not a page.\n",
  });
}

/** A project with a `wiki` directory and no concept directory, so the concept listing cannot be made. */
const seedBare = (root: string): Promise<void> => writeFiles(root, { [`${QUERIES_DIR}/saved.md`]: page("title: Saved") });

/** The real disk generation: the Map of Content it wrote, read back. */
async function mocOnDisk(root: string): Promise<string> {
  await generateMOC(root);
  return readFile(path.join(root, MOC_FILE), "utf-8");
}

mintOnceThenRemove(tracker, async () => {
  wiki = await mintCopied(tracker, PREFIX, seedWiki, mocOnDisk);
  bare = await mintCopied(tracker, PREFIX, seedBare, mocOnDisk);
});

/** One Map of Content generation over a copy: the concept directory's listing and page texts, and a publication that is captured, or refused with `refusal`. */
function generationOver(copy: Copy, refusal?: Error): Generation<MocGenerationSources> {
  return captureGeneration<MocGenerationSources>((log, publish) => {
    const concepts = pageScanOf(copy, CONCEPTS_DIR, (call) => { log.push(call); });
    return {
      listConceptNames: () => concepts.listNames(),
      readConceptPage: (slug) => concepts.readPage(slug),
      publishMoc: (content) => publish("publish", content),
    };
  }, refusal);
}

/** Run the Map of Content generator once over `copy` and hand back what it published and logged. */
const generated = (copy: Copy): Promise<Generation<MocGenerationSources>> => ranGeneration(generationOver(copy), generateMOCFrom);

/**
 * `sources` with ONE page's read replaced: the attempt is logged as any read
 * is, then `outcome` is returned, or thrown when it is an `Error`.
 */
function withReadOf(generation: Generation<MocGenerationSources>, slug: string, outcome: ConfinedReadResult | Error): MocGenerationSources {
  const { sources, log } = generation;
  return { ...sources, readConceptPage: async (asked) => {
    if (asked !== slug) return sources.readConceptPage(asked);
    log.push(`page ${CONCEPTS_DIR}/${slug}`);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  } };
}

/** Record each status report in `log` as `warning <icon> <message>`, in place among the reads. */
const logStatusInto = (log: string[]) => vi.spyOn(output, "status").mockImplementation((icon, message) => { log.push(`warning ${icon} ${message}`); });

/** The page reads a generation over the wiki must make: one per `.md` name, in the order the disk listed the directory. */
const expectedReads = (): string[] => wiki.copy.listings.get(CONCEPTS_DIR)!
  .map((entry) => entry.name).filter((name) => name.endsWith(".md")).map((name) => `page ${CONCEPTS_DIR}/${name.slice(0, -3)}`);

describe("Map of Content generation over copied projects, with the directories gone", () => {
  it("M1 runs after both minting directories were removed, on copies holding no journal, binding leaf or profile", () => {
    expectRemovedDefaultCopies([wiki, bare], PREFIX);
  });

  it("M2 publishes, once, exactly the Map of Content the disk generation wrote, with nothing normalized", async () => {
    expect((await generated(wiki.copy)).published).toEqual([wiki.onDisk]);
  });

  it("M3 groups by tag in tag order, sorts each group by title, falls back to the slug, puts the untagged page last, and leaves out the orphaned and empty pages", async () => {
    expect((await generated(wiki.copy)).published[0]!.split("\n")).toEqual([
      "# Map of Content", "",
      "## ml", "", "- [[zeta|Alpha Tool]]", "- [[beta|beta]]", "",
      "## tools", "", "- [[zeta|Alpha Tool]]", "- [[alpha|Zed Tool]]", "",
      "## Uncategorized", "", "- [[plain|Plain]]", "",
    ]);
  });

  it("M4 publishes the bare heading when the concept directory cannot be listed, exactly as the disk did, reading no page", async () => {
    const { published, log } = await generated(bare.copy);
    expect([published, log]).toEqual([[bare.onDisk], [`list ${CONCEPTS_DIR}`, "publish"]]);
    expect(bare.onDisk).toBe("# Map of Content\n");
  });
});

describe("the reads and the one publication a Map of Content generation makes", () => {
  it("M5 lists once, reads each .md page once in listing order and nothing else, then publishes once", async () => {
    const { log } = await generated(wiki.copy);
    expect(log).toEqual([`list ${CONCEPTS_DIR}`, ...expectedReads(), "publish"]);
    expect([expectedReads().length, wiki.copy.files.has(MOC_FILE), log.filter((call) => call.includes("MOC"))]).toEqual([6, true, []]);
  });

  it("M6 rejects with the publication's own error when publication is refused, after every read and with nothing captured", async () => {
    const refusal = new Error("publication refused");
    const { sources, log, published } = generationOver(wiki.copy, refusal);
    await expect(generateMOCFrom(sources)).rejects.toBe(refusal);
    expect([published, log]).toEqual([[], [`list ${CONCEPTS_DIR}`, ...expectedReads(), "publish"]]);
  });

  it("M7 warns once about a dropped page, naming the bare slug.md and the read's reason, before the next read, then leaves it out and publishes the rest", async () => {
    const generation = generationOver(wiki.copy);
    logStatusInto(generation.log);
    await generateMOCFrom(withReadOf(generation, "alpha", { dropped: "escapes-dir" }));
    const warnings = generation.log.filter((call) => call.startsWith("warning "));
    expect([warnings.length, warnings[0]!.includes("warning ! "), warnings[0]!.includes("Dropped wiki read (escapes-dir): alpha.md — "), warnings[0]!.includes(CONCEPTS_DIR)]).toEqual([1, true, true, false]);
    const reads = expectedReads();
    const dropped = reads.indexOf(`page ${CONCEPTS_DIR}/alpha`);
    expect(generation.log).toEqual([`list ${CONCEPTS_DIR}`, ...reads.slice(0, dropped + 1), warnings[0], ...reads.slice(dropped + 1), "publish"]);
    expect([generation.published.length, generation.published[0]!.includes("[[alpha|"), generation.published[0]!.includes("[[zeta|Alpha Tool]]")]).toEqual([1, false, true]);
  });

  it("M8 fails the generation when a page read rejects: the read's own error, no warning, no later read and no publication", async () => {
    const failure = new Error("read failed");
    const generation = generationOver(wiki.copy);
    logStatusInto(generation.log);
    const first = expectedReads()[0]!;
    await expect(generateMOCFrom(withReadOf(generation, first.slice(`page ${CONCEPTS_DIR}/`.length), failure))).rejects.toBe(failure);
    expect([generation.published, generation.log]).toEqual([[], [`list ${CONCEPTS_DIR}`, first]]);
  });
});

describe("Map of Content generation on real disk, through the default binding", () => {
  it("M9 drops a concept page that links outside the project, warns once naming the bare slug.md, and writes none of the outside text", async () => {
    const [root, outside] = [await tracker.create(PREFIX), await tracker.create(PREFIX)];
    await writeFiles(root, { [`${CONCEPTS_DIR}/kept.md`]: page("title: Kept") });
    await writeFiles(outside, { "secret.md": page("title: Outside Secret\ntags: [leaked]") });
    await symlink(path.join(outside, "secret.md"), path.join(root, CONCEPTS_DIR, "escape.md"));
    const log: string[] = [];
    logStatusInto(log);
    expect(await mocOnDisk(root)).toBe("# Map of Content\n\n## Uncategorized\n\n- [[kept|Kept]]\n");
    expect([log.length, log[0]!.includes("warning ! "), log[0]!.includes("Dropped wiki read (escapes-dir): escape.md — "), log[0]!.includes(CONCEPTS_DIR)]).toEqual([1, true, true, false]);
  });
});

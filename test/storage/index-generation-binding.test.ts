/**
 * @file test/storage/index-generation-binding.test.ts
 * @description The WHOLE index generator, `generateIndexFrom`, with no project
 * directory, publication included. It exists only after the generator was
 * given sources of its own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Two projects are minted on real disk, once: a default wiki
 * (concepts whose titles sort differently from their slugs, an orphaned and an
 * untitled concept, one saved query) and a typed project with a legacy custom
 * profile and no query directory. The real `generateIndex(root)` writes each
 * project's index, the index text is read back, the trees are copied into
 * memory, and the directories are removed before any case runs. Each case then
 * runs the root-free body over the copy and CAPTURES what it publishes. See
 * `copied-project.ts`.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The generator body, and under it the REAL lower
 * bodies: the page scan and its summaries, the profile loader and its
 * non-default gate, and the entity-page collection. The sort, the exclusions,
 * the sections, the links and the count are the production renderer's. No
 * summary, entity page or index text is supplied by hand as an input.
 *
 * WHAT IS COMPARED. The captured text against the text the disk generation
 * wrote, byte for byte, after ONE normalization: the footer's generation time,
 * which the renderer takes from the clock. Nothing else is normalized.
 *
 * WHAT A CAPTURED WRITE SHOWS, AND WHAT IT DOES NOT. It shows which text the
 * generator hands to publication, that it does so once and last, and that a
 * publication which rejects is not followed by the success report. It shows
 * NOTHING about the disk writer: that a reader sees the old or the new index,
 * confinement of the write, durability, locking or recovery. Those belong to
 * the incumbent atomic writer and are shown only by the disk tests
 * (`indexgen.test.ts`, `compile-derived-confine.test.ts`).
 *
 * THE TYPED PROJECT IS A LEGACY CUSTOM PROFILE with no active product binding.
 * Its cases say nothing about an active product package, lifecycle, provenance
 * or any authority. Nothing here is a hosted store or `ProjectStore`.
 */

import { describe, expect, it, vi } from "bun:test";
import { collectPageSummariesFrom, generateIndexFrom, type IndexGenerationSources } from "../../src/compiler/indexgen.js";
import { collectEntityPagesWithMessagesFrom, loadNonDefaultProfileFrom } from "../../src/profile/block.js";
import { CONCEPTS_DIR, PROFILE_FILE, QUERIES_DIR } from "../../src/utils/constants.js";
import * as output from "../../src/utils/output.js";
import { generateAndReadIndex } from "../fixtures/generate-and-read-index.js";
import { SAMPLE_PROFILE } from "../fixtures/profile-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";
import {
  captureGeneration, effectiveProfileOf, entityScansOf, expectRemovedDefaultCopies, expectRemovedLegacyProfileCopies, mintCopied,
  mintOnceThenRemove, pageScanOf, ranGeneration, stepsOf, writeFiles, type Copy, type Generation, type Minted,
} from "./copied-project.js";

const PREFIX = "index-generation-";
/** The path the typed project's doubles give as the project's real root; entry locators are made from it. */
const REAL_ROOT = "/copied/project";
const NOTES_DIR = "wiki/notes";
const page = (frontmatter: string): string => `---\n${frontmatter}\n---\n\nBody.\n`;
/** The one thing normalized before two index texts are compared: the footer's generation time. */
const withoutClock = (index: string): string => index.replace(/Generated \S+_\n$/, "Generated <time>_\n");

const tracker = tempRootTracker();
let wiki: Minted<string>;
let typed: Minted<string>;

/** Concepts whose TITLE order (Apple, Banana) is the reverse of their slug order; an orphaned and an untitled concept; one saved query. */
function seedWiki(root: string): Promise<void> {
  return writeFiles(root, {
    [`${CONCEPTS_DIR}/a-second.md`]: page("title: Banana"),
    [`${CONCEPTS_DIR}/b-first.md`]: page("title: Apple\nsummary: Cites [[alpha]] once."),
    [`${CONCEPTS_DIR}/gone.md`]: page("title: Gone\norphaned: true"),
    [`${CONCEPTS_DIR}/untitled.md`]: page("summary: No title."),
    [`${CONCEPTS_DIR}/README.txt`]: "Not a page.\n",
    [`${QUERIES_DIR}/saved.md`]: page("title: Saved\nsummary: An answer."),
  });
}

/** A `SAMPLE_PROFILE` project: one concept, two titled notes written out of slug order, a note with no title, a file that is not slug-safe; no queries. */
function seedTyped(root: string): Promise<void> {
  return writeFiles(root, {
    [PROFILE_FILE]: JSON.stringify(SAMPLE_PROFILE),
    [`${CONCEPTS_DIR}/alpha.md`]: page("title: Alpha\nsummary: A concept."),
    [`${NOTES_DIR}/note-b.md`]: page("title: Bravo"), [`${NOTES_DIR}/note-a.md`]: page("title: Alfa"),
    [`${NOTES_DIR}/untitled.md`]: page("slug: untitled"), [`${NOTES_DIR}/Bad_Name.md`]: page("title: Bad name"),
  });
}

/** The real disk generation, quietly: the index it wrote, read back. */
const indexOnDisk = (root: string): Promise<string> => output.withQuiet(() => generateAndReadIndex(root));

mintOnceThenRemove(tracker, async () => {
  wiki = await mintCopied(tracker, PREFIX, seedWiki, indexOnDisk);
  typed = await mintCopied(tracker, PREFIX, seedTyped, indexOnDisk);
});

/**
 * One index generation over a copy: the real lower bodies over doubles, and a
 * publication that is captured, or refused with `refusal`. Its log holds every
 * call and status report in order, as `<step>:<call>`.
 */
function generationOver(copy: Copy, refusal?: Error): Generation<IndexGenerationSources> {
  return captureGeneration<IndexGenerationSources>((log, publish) => {
    const note = (step: string) => (call: string): void => { log.push(`${step}:${call}`); };
    vi.spyOn(output, "status").mockImplementation((icon) => { note("status")(icon); });
    return {
      conceptSummaries: () => collectPageSummariesFrom(pageScanOf(copy, CONCEPTS_DIR, note("concepts"))),
      querySummaries: () => collectPageSummariesFrom(pageScanOf(copy, QUERIES_DIR, note("queries"))),
      loadProfile: () => loadNonDefaultProfileFrom(effectiveProfileOf(copy, note("profile"))),
      collectEntityPages: (loaded) => collectEntityPagesWithMessagesFrom(
        { scans: entityScansOf(copy, REAL_ROOT, note("entity")), realRoot: async () => REAL_ROOT, root: REAL_ROOT }, loaded),
      publishIndex: (content) => publish("publish:index", content),
    };
  }, refusal);
}

/** Run the index generator once over `copy` and hand back what it published and logged. */
const generated = (copy: Copy): Promise<Generation<IndexGenerationSources>> => ranGeneration(generationOver(copy), generateIndexFrom);

describe("the two copied projects", () => {
  it("G1 are all that is left: both minting directories are gone, neither copy holds a journal or a binding leaf, and only the typed one holds a profile", () => {
    expectRemovedDefaultCopies([wiki], PREFIX);
    expectRemovedLegacyProfileCopies([typed], PREFIX);
  });
});

describe("index generation over a copied default project, with the directory gone", () => {
  it("I2 publishes, once, exactly the index the disk generation wrote, apart from the generation time", async () => {
    const { published } = await generated(wiki.copy);
    expect(published.map(withoutClock)).toEqual([withoutClock(wiki.onDisk)]);
    expect(wiki.onDisk).toMatch(/Generated \d{4}-\d{2}-\d{2}T\S+Z_\n$/);
  });

  it("I3 sorts by title, leaves out the orphaned and untitled concepts, strips wikilinks from summaries, and counts what it lists", async () => {
    const { published } = await generated(wiki.copy);
    expect(withoutClock(published[0]!).split("\n")).toEqual([
      "# Knowledge Wiki", "", "## Concepts", "",
      "- **[[b-first|Apple]]** — Cites alpha once.", "- **[[a-second|Banana]]** — ",
      "", "## Saved Queries", "", "- **[[saved|Saved]]** — An answer.",
      "", "_3 pages | Generated <time>_", "",
    ]);
  });

  it("I4 announces, reads concepts then queries then the profile, publishes, and only then reports success", async () => {
    const { log } = await generated(wiki.copy);
    expect(stepsOf(log)).toEqual(["status", "concepts", "queries", "profile", "publish", "status"]);
    expect([log[0], log[log.length - 2], log[log.length - 1]]).toEqual(["status:*", "publish:index", "status:+"]);
  });

  it("I5 reports no success when publication is refused, and rejects with the publication's own error", async () => {
    const refusal = new Error("publication refused");
    const { sources, log, published } = generationOver(wiki.copy, refusal);
    await expect(generateIndexFrom(sources)).rejects.toBe(refusal);
    expect([published, log.filter((call) => call.startsWith("status:")), log[log.length - 1]]).toEqual([[], ["status:*"], "publish:index"]);
  });
});

describe("index generation over a copied legacy-profile project, with the directory gone", () => {
  it("T2 publishes, once, exactly the index the disk generation wrote, apart from the generation time", async () => {
    const { published } = await generated(typed.copy);
    expect(published.map(withoutClock)).toEqual([withoutClock(typed.onDisk)]);
  });

  it("T3 adds one section for the typed pages, by slug, with a link and an id each, and counts them in the total", async () => {
    const { published } = await generated(typed.copy);
    expect(withoutClock(published[0]!).split("\n")).toEqual([
      "# Knowledge Wiki", "", "## Concepts", "", "- **[[alpha|Alpha]]** — A concept.",
      "", "## Notes", "",
      "- **[Alfa](notes/note-a.md)** — `notes/note-a`", "- **[Bravo](notes/note-b.md)** — `notes/note-b`",
      "- **[untitled](notes/untitled.md)** — `notes/untitled`",
      "", "_4 pages | Generated <time>_", "",
    ]);
  });

  it("T4 collects the typed pages after the profile and before publication, with no query section for a project without queries", async () => {
    const { log, published } = await generated(typed.copy);
    expect(stepsOf(log)).toEqual(["status", "concepts", "queries", "profile", "entity", "publish", "status"]);
    expect([published[0]!.includes("## Saved Queries"), log.filter((call) => call === "publish:index").length]).toEqual([false, 1]);
  });
});

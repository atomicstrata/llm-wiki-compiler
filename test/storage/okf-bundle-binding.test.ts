/**
 * @file test/storage/okf-bundle-binding.test.ts
 * @description The WHOLE OKF bundle writer, `buildOkfBundleFrom`, with no project
 * directory and no output directory on disk. It exists only after the writer was
 * given its path operations and reads, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Two projects are minted on real disk, once: a default-profile
 * wiki (a concept citing one held and one missing source, a foreign page whose
 * `x-okf` path is not restorable, an llmwiki activity log), and the newsroom
 * fixture with its relation and a log. Their export pages come from the real
 * `collectExportPages`. On disk, the real `buildOkfBundle` exports each into an
 * EXTERNAL directory: the wiki twice (a stale page dropped by the second pass),
 * the newsroom twice as well; the wiki also meets three refusals. The disk's written
 * paths, warnings, output bytes and refusal messages are kept, the trees are
 * copied, and every directory is removed before any case runs: the tracker that
 * created them all removes them all. B1 ASSERTS only the two minting
 * directories gone; the external output directories are removed by that
 * cleanup, not by a separate assertion.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The whole body: the target refusals and their
 * order, the bundle recognition and nested `.git` scan, the clear, the output
 * paths, reference selection, the profile load and both profile surfaces, the
 * rendering, every write and copy in order, the log and the warnings.
 *
 * WHAT THE DOUBLES DECIDE. The in-memory tree answers what a map of files and a
 * set of directories can: whether a path exists and its kind, a file's text, a
 * directory's names, and it RECORDS each explicit directory creation, file
 * written, file copied and entry removed (`okf-bundle-doubles.ts`); the parents a
 * write creates implicitly are not recorded. It has no links, so its real path is the path, and
 * its `confine` is a lexical stand-in for the disk mechanism (the escape of a
 * linked parent is shown only on disk, in `okf-bundle.test.ts`). The run store
 * is answered as absent; the copies hold no workflow store.
 *
 * NOT SHOWN HERE: the disk mechanisms themselves (realpath through links,
 * atomic replacement, durability, confinement against a linked parent), the
 * filesystem-root refusal, `runOkfExport`'s default directory and journal
 * warning, and the CLI. The doubles are not a hosted store, not an
 * access-control layer and not `ProjectStore`.
 */

import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { collectExportPages } from "../../src/export/collect.js";
import { buildOkfBundle, buildOkfBundleFrom, type OkfBundleSources } from "../../src/export/okf/bundle.js";
import { safeRefName } from "../../src/export/okf/mapping.js";
import type { ExportPage } from "../../src/export/types.js";
import { LLMWIKI_DIR } from "../../src/utils/constants.js";
import { buildNewsroomProject, seedNewsroomRelations } from "../fixtures/newsroom-profile.js";
import { tempRootTracker } from "../temp-roots.js";
import { mintCopied, mintOnceThenRemove, stepsOf, writeFiles, type Minted } from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";
import { bundleSourcesOf, MEM_ROOT, memoryTree } from "./okf-bundle-doubles.js";

const PREFIX = "okf-bundle-binding-";
const MEM_OUT = "/memory/out/bundle";
const LOG = "# Log\n\n## [2026-02-01T00:00:00Z] compile | Compiled two sources\n";
const SOURCE_TEXT = "# A\nThe held source.\n";
/** Where the held source is copied in the bundle, by the production naming rule. */
const REF_REL = `references/${safeRefName("a.md")}`;

/** One export as observed: written paths relative to the real output dir, warnings, and every output file's bytes. */
interface Exported { written: string[]; warnings: string[]; files: Map<string, Buffer> }
/** What the disk answered for one project. */
interface OnDisk { pages: ExportPage[]; first: Exported; final: Exported; refusals: Record<string, string> }

const tracker = tempRootTracker();
let wiki: Minted<OnDisk>;
let newsroom: Minted<OnDisk>;

/** The default wiki: a concept citing a held and a missing source, a foreign page with an unrestorable okfPath, a log. */
function seedWiki(root: string): Promise<void> {
  return writeFiles(root, {
    "sources/a.md": SOURCE_TEXT, "log.md": LOG,
    "wiki/concepts/rag.md": "---\ntitle: RAG\nsummary: Grounded.\n---\n\nRAG cites ^[a.md:1-2] and ^[ghost.md].\n",
    "wiki/concepts/stale.md": "---\ntitle: Stale\n---\n\nDropped by the second pass.\n",
    "wiki/concepts/foreign.md": "---\ntitle: Foreign\nx-okf:\n  originalFrontmatter: {}\n  okfPath: index.md\n---\n\nImported.\n",
  });
}

/** The newsroom fixture with its relation, and a log. */
async function seedNewsroom(root: string): Promise<void> {
  await buildNewsroomProject(root);
  await seedNewsroomRelations(root);
  await writeFiles(root, { "log.md": LOG });
}

/** Every regular file under `dir`, by relative path, as bytes. */
async function filesUnder(dir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = path.join(entry.parentPath, entry.name);
    files.set(path.relative(dir, abs), await readFile(abs));
  }
  return files;
}

/** One real export on disk into `out`. */
async function exportOnDisk(root: string, pages: ExportPage[], out: string): Promise<Exported> {
  const warnings: string[] = [];
  const written = await buildOkfBundle(root, pages, out, (m) => warnings.push(m));
  const realOut = await realpath(out);
  return { written: written.map((abs) => path.relative(realOut, abs)), warnings, files: await filesUnder(realOut) };
}

/** The message a rejected disk export gave, with `out` written as `<out>`. */
const refusal = (run: Promise<unknown>, out: string): Promise<string> =>
  run.then(() => "resolved", (error: Error) => error.message.split(out).join("<out>"));

/** The three refusals, on disk: the project root, a foreign non-empty dir, a recognized bundle holding a nested .git. */
async function refusalsOnDisk(root: string, pages: ExportPage[], bundleOut: string): Promise<Record<string, string>> {
  const occupied = path.join(await tracker.create(PREFIX), "occupied");
  await writeFiles(occupied, { "notes.txt": "Not a bundle.\n" });
  await mkdir(path.join(bundleOut, "concepts", ".git"));
  return {
    projectRoot: await refusal(buildOkfBundle(root, pages, root, () => {}), root),
    foreign: await refusal(buildOkfBundle(root, pages, occupied, () => {}), occupied),
    nestedGit: await refusal(buildOkfBundle(root, pages, bundleOut, () => {}), await realpath(bundleOut)),
  };
}

/** Export twice into one external dir, the first time with every page; the wiki also meets the refusals. */
async function askedOnDisk(root: string, withRefusals: boolean): Promise<OnDisk> {
  const pages = await collectExportPages(root);
  const out = path.join(await tracker.create(PREFIX), "bundle");
  const first = await exportOnDisk(root, pages, out);
  const final = await exportOnDisk(root, pages.filter((page) => page.slug !== "stale"), out);
  return { pages, first, final, refusals: withRefusals ? await refusalsOnDisk(root, pages, out) : {} };
}

mintOnceThenRemove(tracker, async () => {
  wiki = await mintCopied(tracker, PREFIX, seedWiki, (root) => askedOnDisk(root, true));
  newsroom = await mintCopied(tracker, PREFIX, seedNewsroom, (root) => askedOnDisk(root, false));
});

/** One export through the production body over the memory tree, observed as on disk. */
async function exportInMemory(memory: ReturnType<typeof memoryTree>, sources: OkfBundleSources, pages: ExportPage[]): Promise<Exported> {
  const warnings: string[] = [];
  const written = await buildOkfBundleFrom(sources, MEM_ROOT, pages, MEM_OUT, (m) => warnings.push(m));
  const files = new Map([...memory.files].filter(([p]) => p.startsWith(`${MEM_OUT}/`)).map(([p, text]) => [path.posix.relative(MEM_OUT, p), Buffer.from(text)] as const));
  return { written: written.map((abs) => path.posix.relative(MEM_OUT, abs)), warnings, files };
}

/** Both passes in memory, each with its own effect log. */
async function twoPasses(project: Minted<OnDisk>) {
  const effects: string[] = [];
  const log: string[] = [];
  const memory = memoryTree(project.copy, effects);
  const sources = bundleSourcesOf(project.copy, memory.tree, log);
  const first = await exportInMemory(memory, sources, project.onDisk.pages);
  const firstEffects = effects.splice(0);
  const final = await exportInMemory(memory, sources, project.onDisk.pages.filter((page) => page.slug !== "stale"));
  return { memory, sources, first, firstEffects, final, finalEffects: [...effects], log };
}

describe("the OKF bundle writer over copied projects, with every directory gone", () => {
  it("B1 runs after every minting directory was removed, on copies holding no binding leaf and no workflow store", () => {
    for (const one of [wiki, newsroom]) expectMintingDirectoryRemoved(one.dir, PREFIX);
    expect([wiki, newsroom].map((one) => [one.copy.files.has(`${LLMWIKI_DIR}/active-product.json`), one.copy.listings.has(`${LLMWIKI_DIR}/workflows`)]))
      .toEqual([[false, false], [false, false]]);
  });

  it("B2 writes the default wiki exactly as the disk did: order, bytes, the copied reference and both warnings", async () => {
    const { first, firstEffects } = await twoPasses(wiki);
    expect(first).toEqual(wiki.onDisk.first);
    expect(first.files.get(REF_REL)).toEqual(Buffer.from(SOURCE_TEXT));
    expect(first.warnings).toHaveLength(2);
    expect([firstEffects[0], firstEffects.filter((e) => e.startsWith("remove"))]).toEqual([`mkdir ${MEM_OUT}`, []]);
    expect(firstEffects).toContain(`copy ${MEM_ROOT}/sources/a.md -> ${MEM_OUT}/${REF_REL}`);
  });

  it("B3 clears the recognized prior bundle before its first write, and ends as the disk did", async () => {
    const { final, finalEffects } = await twoPasses(wiki);
    expect(final).toEqual(wiki.onDisk.final);
    expect(final.files.has("concepts/stale.md")).toBe(false);
    const firstWrite = finalEffects.findIndex((e) => e.startsWith("write"));
    expect([finalEffects.slice(0, firstWrite).every((e) => e.startsWith("remove")), firstWrite > 0]).toEqual([true, true]);
  });

  it("B4 writes the newsroom bundle exactly as the disk did: entity docs and the x-llmwiki block", async () => {
    const { first, final, log } = await twoPasses(newsroom);
    expect([first, final]).toEqual([newsroom.onDisk.first, newsroom.onDisk.final]);
    expect([...final.files.keys()].filter((rel) => /^(articles|desks|bylines)\//.test(rel)).sort()).toEqual(
      ["articles/port-strike-latest.md", "bylines/j-rivera.md", "desks/metro.md"]);
    expect(final.files.get("index.md")!.toString("utf8")).toContain("x-llmwiki:");
    expect(stepsOf(log).slice(0, 5)).toEqual(["profile", "scans", "graph", "runs", "profile"]);
  });

  it("B5 refuses the project root, a foreign non-empty dir and a nested .git with the disk's messages, before any effect", async () => {
    const effects: string[] = [];
    const memory = memoryTree(wiki.copy, effects);
    const sources = bundleSourcesOf(wiki.copy, memory.tree, []);
    const asked = (out: string) => refusal(buildOkfBundleFrom(sources, MEM_ROOT, wiki.onDisk.pages, out, () => {}), out);
    expect(await asked(MEM_ROOT)).toBe(wiki.onDisk.refusals.projectRoot);
    memory.files.set("/memory/out/occupied/notes.txt", "Not a bundle.\n");
    memory.dirs.add("/memory/out/occupied");
    expect([await asked("/memory/out/occupied"), effects]).toEqual([wiki.onDisk.refusals.foreign, []]);
    await exportInMemory(memory, sources, wiki.onDisk.pages);
    memory.dirs.add(`${MEM_OUT}/concepts/.git`);
    effects.splice(0);
    expect([await asked(MEM_OUT), effects]).toEqual([wiki.onDisk.refusals.nestedGit, []]);
  });
});

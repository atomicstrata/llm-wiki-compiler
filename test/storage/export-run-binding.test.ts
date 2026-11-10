/**
 * @file test/storage/export-run-binding.test.ts
 * @description The two WHOLE top-level export bodies, `runExportFrom` (the file
 * export: six default formats, or one target, `okf` included) and
 * `runOkfExportFrom` (the output-free OKF core), with no project directory. Both
 * exist only after the export was given its sources, so this file has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. Two projects are minted on real disk, once: a named wiki
 * (package.json with a name, a held and a missing cited source, a query, an
 * activity log, no state record, so no source is hashed) and a bare wiki (no
 * package.json). The named wiki's default export embeds a projectId; the bare
 * wiki's embeds none. Each project's options are one constant, used on disk and
 * in memory alike. On disk the real `runExport`
 * writes the six default formats; for the named wiki it then runs the `okf`
 * target, then `runOkfExport` with its default directory (which must clear the
 * bundle just written), then meets an unknown target and an invalid projectId.
 * What the disk wrote and answered is kept, the generated `dist/` is removed
 * (test cleanup), the trees are copied, and every minting directory is removed
 * before any case runs. The run's own clock in llms.txt, wiki.json and the marp
 * deck is set aside as `<clock>` on both sides.
 *
 * WHAT RUNS FOR REAL IN MEMORY. Both bodies: the option checks and their order,
 * the pages, the title decision, the profile block, the journal warnings, the
 * target selection, every format's content, the write order, the opt-in OKF
 * branch with its own page collection, the default OKF directory, the whole
 * bundle writer, and the report and its warnings.
 *
 * WHAT THE DOUBLES DECIDE. The page, state, source, profile and journal doubles
 * of `copied-project.ts` and `export-profile-doubles.ts`, the in-memory tree of
 * `okf-bundle-doubles.ts` (which also takes the single-file writes), and a
 * package.json load that parses the copied text and throws when the copy holds
 * none. It stands in for the module loader: its CACHE is not shown here.
 *
 * NOT SHOWN HERE: the loader's cache, the atomic writer, the CLI's own output
 * lines (printed on both sides, not asserted), a journal that exists, and the
 * MCP and SDK adapters. The doubles are not a hosted store, not an
 * access-control layer and not `ProjectStore`.
 */

import { readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { runExport, runExportFrom, type RunExportSources } from "../../src/commands/export.js";
import { runOkfExport, runOkfExportFrom } from "../../src/export/okf/run.js";
import { EXPORT_DIR, LLMWIKI_DIR } from "../../src/utils/constants.js";
import { tempRootTracker } from "../temp-roots.js";
import {
  absentJournalOf, entityScansOf, heldText, mintCopied, mintOnceThenRemove, recordsOf, sourceFreshnessOf, stepsOf, writeFiles,
  type Copy, type Minted, type Note,
} from "./copied-project.js";
import { exportProfileSourcesOf } from "./export-profile-doubles.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";
import { bundleSourcesOf, MEM_ROOT, memoryTree } from "./okf-bundle-doubles.js";

const PREFIX = "export-run-binding-";
const PROJECT_ID = "binding-wiki";
/** The default-export options, ONE per project and used on both sides: the named wiki embeds a projectId, the bare wiki none. */
const NAMED_OPTIONS = { projectId: PROJECT_ID };
const BARE_OPTIONS = {};
const CLOCK = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const OKF_REL = `${EXPORT_DIR}/okf`;

/** What one export wrote: paths relative to the project, and each file's text with the run's clock set aside. */
interface Written { written: string[]; texts: Record<string, string> }
/** What the disk answered for one project. */
interface OnDisk {
  defaults: Written & { pageCount: number };
  okf?: { viaTarget: string[]; outDir: string; report: string[]; warnings: string[]; bundle: Record<string, string> };
  refusals?: { target: string; projectId: string };
}

const tracker = tempRootTracker();
let named: Minted<OnDisk>;
let bare: Minted<OnDisk>;

const unclocked = (text: string): string => text.replace(CLOCK, "<clock>");
const message = (run: Promise<unknown>): Promise<string> => run.then(() => "resolved", (error: Error) => error.message);

/** Each written file's text, keyed by its path relative to `base`. */
async function textsOf(base: string, written: string[]): Promise<Record<string, string>> {
  const entries = await Promise.all(written.map(async (abs) => [path.relative(base, abs), unclocked(await readFile(abs, "utf8"))] as const));
  return Object.fromEntries(entries);
}

/** The OKF part, on disk: the target, the core into its default dir (a re-export), and the bundle's files. */
async function okfOnDisk(root: string): Promise<NonNullable<OnDisk["okf"]>> {
  const realRoot = await realpath(root);
  const viaTarget = (await runExport(root, { target: "okf" })).written.map((abs) => path.relative(realRoot, abs));
  const report = await runOkfExport(root);
  const bundleDir = path.join(realRoot, OKF_REL);
  const files = (await readdir(bundleDir, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  const bundle = await textsOf(bundleDir, files.map((entry) => path.join(entry.parentPath, entry.name)));
  return { viaTarget, outDir: path.relative(root, report.outDir), report: report.writtenPaths.map((abs) => path.relative(realRoot, abs)), warnings: report.warnings, bundle };
}

/** Ask the real root-taking exports, then remove what they generated so the copy holds the project only. */
async function askedOnDisk(root: string, options: { projectId?: string }, withOkf: boolean): Promise<OnDisk> {
  const result = await runExport(root, options);
  const defaults = { written: result.written.map((abs) => path.relative(root, abs)), texts: await textsOf(root, result.written), pageCount: result.pageCount };
  const okf = withOkf ? await okfOnDisk(root) : undefined;
  const refusals = withOkf
    ? { target: await message(runExport(root, { target: "bogus" })), projectId: await message(runExport(root, { projectId: "Not Valid" })) }
    : undefined;
  await rm(path.join(root, "dist"), { recursive: true, force: true });
  return { defaults, okf, refusals };
}

/** A named wiki: package.json, a concept citing a held and a missing source, a query, a log. */
function seedNamed(root: string): Promise<void> {
  return writeFiles(root, {
    "package.json": JSON.stringify({ name: "binding-wiki", version: "1.0.0" }), "sources/a.md": "# A\nHeld.\n",
    "log.md": "# Log\n\n## [2026-02-01T00:00:00Z] compile | Compiled one source\n",
    "wiki/concepts/rag.md": "---\ntitle: RAG\nsummary: Grounded.\n---\n\nRAG cites ^[a.md:1-2] and ^[ghost.md], and links [[Notes]].\n",
    "wiki/queries/notes.md": "---\ntitle: Notes\n---\n\nA saved answer.\n",
  });
}

mintOnceThenRemove(tracker, async () => {
  named = await mintCopied(tracker, PREFIX, seedNamed, (root) => askedOnDisk(root, NAMED_OPTIONS, true));
  bare = await mintCopied(tracker, PREFIX, (root) => writeFiles(root, { "wiki/concepts/solo.md": "---\ntitle: Solo\n---\n\nAlone.\n" }), (root) => askedOnDisk(root, BARE_OPTIONS, false));
});

/** The export sources over one copy and one in-memory tree, each read logged as `<step>:<call>`. */
function runSourcesOf(copy: Copy, memory: ReturnType<typeof memoryTree>, log: string[]): RunExportSources {
  const as = (step: string): Note => (call) => { log.push(`${step}:${call}`); };
  const pagesOf = () => ({ scans: entityScansOf(copy, MEM_ROOT, as("content")), records: recordsOf(copy, as("state")), freshness: sourceFreshnessOf(copy, as("freshness")) });
  return {
    pages: pagesOf(), profile: exportProfileSourcesOf(copy, MEM_ROOT, log), journal: absentJournalOf(as("journal")),
    okf: { pages: pagesOf(), journal: absentJournalOf(as("journal")), bundle: bundleSourcesOf(copy, memory.tree, log) },
    loadPackageJson: (location) => { as("package")(location); return JSON.parse(heldText(copy, path.posix.relative(MEM_ROOT, location))) as unknown; },
    writeFile: (location, content) => memory.tree.write(location, content),
  };
}

/** A fresh in-memory run over one project's copy. */
function memoryRun(project: Minted<OnDisk>) {
  const effects: string[] = [];
  const log: string[] = [];
  const memory = memoryTree(project.copy, effects);
  return { effects, log, memory, sources: runSourcesOf(project.copy, memory, log) };
}

/** The in-memory text of each written file, keyed relative to `base`. */
const memoryTexts = (memory: ReturnType<typeof memoryTree>, base: string, written: string[]): Record<string, string> =>
  Object.fromEntries(written.map((abs) => [path.posix.relative(base, abs), unclocked(memory.files.get(abs)!)]));

/** The default export in memory, observed as on disk. */
async function defaultsInMemory(project: Minted<OnDisk>, options: { projectId?: string }) {
  const run = memoryRun(project);
  const result = await runExportFrom(run.sources, MEM_ROOT, options);
  const written = result.written.map((abs) => path.posix.relative(MEM_ROOT, abs));
  return { ...run, observed: { written, texts: memoryTexts(run.memory, MEM_ROOT, result.written), pageCount: result.pageCount } };
}

describe("the top-level export bodies over copied projects, with the directories gone", () => {
  it("R1 runs after every minting directory was removed, on copies holding no generated dist, journal or binding leaf", () => {
    for (const one of [named, bare]) expectMintingDirectoryRemoved(one.dir, PREFIX);
    expect([named, bare].map((one) => ["dist", `${LLMWIKI_DIR}/journal`, `${LLMWIKI_DIR}/active-product.json`]
      .map((rel) => one.copy.listings.has(rel) || one.copy.files.has(rel)))).toEqual([[false, false, false], [false, false, false]]);
  });

  it("R2 writes the six default formats exactly as the disk did, titled from package.json, after its reads in order", async () => {
    const { observed, log } = await defaultsInMemory(named, NAMED_OPTIONS);
    expect(observed).toEqual(named.onDisk.defaults);
    expect(observed.written).toEqual(["llms.txt", "llms-full.txt", "wiki.json", "wiki.jsonld", "wiki.graphml", "wiki.md"].map((file) => `${EXPORT_DIR}/${file}`));
    expect(observed.texts[`${EXPORT_DIR}/llms.txt`]!.startsWith("# binding-wiki\n")).toBe(true);
    expect((JSON.parse(observed.texts[`${EXPORT_DIR}/wiki.json`]!) as { projectId?: string }).projectId).toBe(PROJECT_ID);
    expect(stepsOf(log)).toEqual(["content", "state", "package", "profile", "journal"]);
  });

  it("R3 falls back to the default title when the copy holds no package.json, as the disk did", async () => {
    const { observed } = await defaultsInMemory(bare, BARE_OPTIONS);
    expect(observed).toEqual(bare.onDisk.defaults);
    expect(observed.texts[`${EXPORT_DIR}/llms.txt`]!.startsWith("# Knowledge Wiki\n")).toBe(true);
    expect("projectId" in (JSON.parse(observed.texts[`${EXPORT_DIR}/wiki.json`]!) as object)).toBe(false);
  });

  it("R4 runs the okf target, then the OKF core into its default dir, exactly as the disk did, clearing the first bundle", async () => {
    const { sources, memory, effects } = memoryRun(named);
    const viaTarget = (await runExportFrom(sources, MEM_ROOT, { target: "okf" })).written.map((abs) => path.posix.relative(MEM_ROOT, abs));
    const firstEffects = effects.splice(0);
    const report = await runOkfExportFrom(sources.okf, MEM_ROOT);
    const bundleDir = `${MEM_ROOT}/${OKF_REL}`;
    const bundle = memoryTexts(memory, bundleDir, [...memory.files.keys()].filter((p) => p.startsWith(`${bundleDir}/`)).sort());
    const observed = { viaTarget, outDir: path.posix.relative(MEM_ROOT, report.outDir), report: report.writtenPaths.map((abs) => path.posix.relative(MEM_ROOT, abs)), warnings: report.warnings, bundle };
    expect(observed).toEqual({ ...named.onDisk.okf!, bundle: Object.fromEntries(Object.entries(named.onDisk.okf!.bundle).sort()) });
    expect([observed.outDir, firstEffects.some((e) => e.startsWith("remove")), effects.some((e) => e.startsWith("remove"))]).toEqual([OKF_REL, false, true]);
  });

  it("R5 rejects an unknown target after its reads and before any write, and an invalid projectId before any read, as the disk did", async () => {
    const target = memoryRun(named);
    expect(await message(runExportFrom(target.sources, MEM_ROOT, { target: "bogus" }))).toBe(named.onDisk.refusals!.target);
    expect([stepsOf(target.log), target.effects]).toEqual([["content", "state", "package", "profile", "journal"], []]);
    const projectId = memoryRun(named);
    expect(await message(runExportFrom(projectId.sources, MEM_ROOT, { projectId: "Not Valid" }))).toBe(named.onDisk.refusals!.projectId);
    expect([projectId.log, projectId.effects]).toEqual([[], []]);
  });
});

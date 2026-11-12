/**
 * @file test/storage/lint-fix-proposal-binding.test.ts
 * @description The PLAN half of `lint --fix-propose` as a whole consumer with no
 * project directory: `proposeLintFixFrom` over `LintFixProposalSources`. It
 * exists only after the proposal was given sources of its own, so this file
 * has NO before-edit run.
 *
 * HOW IT IS BUILT. One project is minted on real disk with one page that
 * carries a title under a different filename, and three pages that link to
 * that title: one in `wiki/concepts`, one in a typed directory, one nested two
 * levels down. On disk the real proposal answers for every fix number and for
 * a number out of range. Then, with the working directory set to the project,
 * the real root-taking `lintFixProposeCommand` stages the concepts page's fix
 * under the project lock, and the staged candidate is read back. The private
 * directory that staging created is removed, the tree is copied as raw text
 * and listings, and the directory is removed before any case runs.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The real link plan over the copied pages, the
 * index and routing checks, the one page read, the frontmatter parse, the
 * edit, the hash and the draft. No plan, fix or draft is handed in.
 *
 * WHAT IS COMPARED. Each memory proposal against the disk proposal for the same
 * number; the concepts draft against the candidate the disk command staged;
 * and both against values written out here.
 *
 * WHAT IS NOT SHOWN. Staging: the project lock, the recovery gate and the
 * candidate store are root-only and are NOT run in memory. A pending candidate
 * (the copy holds none), a page outside `wiki/`, and a page directly in
 * `wiki/`. The page read double is a map lookup: it shows nothing about links
 * or confinement on disk.
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { lintFixProposeCommand } from "../../src/commands/lint-fix-propose.js";
import { listCandidates } from "../../src/compiler/candidates.js";
import { sha256Text } from "../../src/connectors/hash.js";
import {
  diskLintFixProposalSources, proposeLintFixFrom, type LintFixProposal, type LintFixProposalSources,
} from "../../src/linter/fix-proposal.js";
import { CONCEPTS_DIR, LLMWIKI_DIR } from "../../src/utils/constants.js";
import { tempRootTracker } from "../temp-roots.js";
import { expectRemovedDefaultCopies, heldText, mintCopied, mintOnceThenRemove, writeFiles, type Minted } from "./copied-project.js";
import { lintSourcesOver, NO_ENTITIES } from "./lint-sources-doubles.js";

const PREFIX = "lint-fix-proposal-";
const LINKER = `${CONCEPTS_DIR}/linker.md`;
const NOTE = "wiki/notes/note.md";
const NESTED = "wiki/research/papers/deep.md";
const LINKER_TEXT = '---\ntitle: "Linker"\nsummary: "Links out."\n---\nSee [[Renamed Page]].\n';
const NOTE_TEXT = "A note with no frontmatter.\nIt uses [[Renamed Page]] on its second line.\n";
const FILES: Record<string, string> = {
  [`${CONCEPTS_DIR}/renamed-file.md`]: '---\ntitle: "Renamed Page"\n---\nBody.\n',
  [LINKER]: LINKER_TEXT,
  [NOTE]: NOTE_TEXT,
  [NESTED]: '---\ntitle: "Deep"\n---\nNested [[Renamed Page]].\n',
};
/** Every fix number the project has, in the plan's order, and one it does not have. */
const NUMBERS = [1, 2, 3];
const OUT_OF_RANGE = 99;

/** What the candidate writer kept of a draft, as far as this suite compares it. */
type Staged = [title: string, slug: string, summary: string, body: string, hash: string | undefined, directory: string | undefined];
/** What the disk answered: each proposal by number, the out-of-range refusal, and the candidate the root command staged for the concepts page. */
interface OnDisk { real: string; proposals: LintFixProposal[]; outOfRange: LintFixProposal; exitCode: number; staged: Staged[] }

const tracker = tempRootTracker();
let project: Minted<OnDisk>;

/** The proposal for the fix on `rel`, and its 1-based number, among proposals given in number order. */
function proposalFor(proposals: readonly LintFixProposal[], root: string, rel: string): { n: number; proposal: LintFixProposal } {
  const at = proposals.findIndex((one) => one.kind === "draft" && one.edit.file === path.join(root, rel));
  if (at < 0) throw new Error(`no draft proposal names ${rel}`);
  return { n: at + 1, proposal: proposals[at]! };
}

/** Stage fix `n` with the real root-taking command from inside `root`, and read back what it staged. */
async function stagedOnDisk(root: string, n: number): Promise<{ exitCode: number; staged: Staged[] }> {
  const cwd = process.cwd();
  process.chdir(root);
  vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const exitCode = await lintFixProposeCommand(n);
    const staged = (await listCandidates(root)).map((one): Staged =>
      [one.title, one.slug, one.summary, one.body, one.expectedTargetHash, one.targetDirectory]);
    return { exitCode, staged };
  } finally {
    vi.restoreAllMocks();
    process.chdir(cwd);
  }
}

/** Ask the disk proposal for every number, then stage the concepts fix and remove what staging created. */
async function askedOnDisk(root: string): Promise<OnDisk> {
  const sources = diskLintFixProposalSources(root);
  const proposals: LintFixProposal[] = [];
  for (const n of NUMBERS) proposals.push(await proposeLintFixFrom(sources, n));
  const outOfRange = await proposeLintFixFrom(sources, OUT_OF_RANGE);
  const result = await stagedOnDisk(root, proposalFor(proposals, root, LINKER).n);
  await rm(path.join(root, LLMWIKI_DIR), { recursive: true, force: true });
  return { real: root, proposals, outOfRange, ...result };
}

mintOnceThenRemove(tracker, async () => { project = await mintCopied(tracker, PREFIX, (root) => writeFiles(root, FILES), askedOnDisk); });

/** The proposal sources over the copy: the shared lint doubles' pages and candidates, and a page read by located path. Each target read is logged as `target <path>`. */
function sourcesOver(events: string[], refusal?: Error): LintFixProposalSources {
  const { pages, candidates } = lintSourcesOver(project, events, NO_ENTITIES);
  return {
    links: { pages, candidates },
    readLocatedPage: async (file) => {
      const rel = path.relative(project.dir, file);
      events.push(`target ${rel}`);
      if (refusal !== undefined) throw refusal;
      return heldText(project.copy, rel);
    },
  };
}

/** The draft of a proposal that was not refused. */
function draftOf(proposal: LintFixProposal): Extract<LintFixProposal, { kind: "draft" }>["draft"] {
  if (proposal.kind !== "draft") throw new Error(`refused: ${proposal.message}`);
  return proposal.draft;
}

const targetReads = (events: string[]): string[] => events.filter((event) => event.startsWith("target "));
const indexRefusal = (n: number): LintFixProposal =>
  ({ kind: "refused", message: `No fixable finding #${n}. Run \`llmwiki lint --fix-preview\` to see the 3 numbered fix(es).` });

describe("the lint fix proposal over a copied project, with the directory gone", () => {
  it("P1 runs after the minting directory was removed, and the disk command staged one candidate", () => {
    expectRemovedDefaultCopies([project], PREFIX);
    expect([project.onDisk.exitCode, project.onDisk.staged.length]).toEqual([0, 1]);
    expect(project.onDisk.proposals.map((one) => one.kind).sort()).toEqual(["draft", "draft", "refused"]);
  });

  it("P2 decides every fix number exactly as the disk proposal did", async () => {
    for (const n of NUMBERS) {
      expect(await proposeLintFixFrom(sourcesOver([]), n)).toEqual(project.onDisk.proposals[n - 1]);
    }
    expect(await proposeLintFixFrom(sourcesOver([]), OUT_OF_RANGE)).toEqual(project.onDisk.outOfRange);
  });

  it("P3 builds the concepts draft the disk command staged: the edited text, the hash of the text read, and the routing", async () => {
    const { n } = proposalFor(project.onDisk.proposals, project.dir, LINKER);
    const draft = draftOf(await proposeLintFixFrom(sourcesOver([]), n));
    expect([[draft.title, draft.slug, draft.summary, draft.body, draft.expectedTargetHash, draft.targetDirectory]]).toEqual(project.onDisk.staged);
    expect(draft).toEqual({
      title: "Linker", slug: "linker", summary: "Links out.", sources: [],
      body: LINKER_TEXT.replace("[[Renamed Page]]", "[[renamed-file|Renamed Page]]"),
      reviewMode: "forced", heldReasons: [{ code: "manual-review-requested" }],
      expectedTargetHash: sha256Text(LINKER_TEXT), targetDirectory: "concepts",
    });
  });

  it("P4 routes a typed directory by its name, and falls back to the slug and an empty summary without frontmatter", async () => {
    const { n } = proposalFor(project.onDisk.proposals, project.dir, NOTE);
    const draft = draftOf(await proposeLintFixFrom(sourcesOver([]), n));
    expect([draft.title, draft.slug, draft.summary, draft.targetEntityType, draft.targetDirectory]).toEqual(["note", "note", "", "notes", undefined]);
    expect(draft.body).toBe(NOTE_TEXT.replace("[[Renamed Page]]", "[[renamed-file|Renamed Page]]"));
    expect(draft.expectedTargetHash).toBe(sha256Text(NOTE_TEXT));
  });

  it("P5 refuses a nested page with the command's message, without reading it", async () => {
    const n = 1 + project.onDisk.proposals.findIndex((one) => one.kind === "refused");
    const events: string[] = [];
    expect(await proposeLintFixFrom(sourcesOver(events), n)).toEqual({
      kind: "refused",
      message: `Cannot propose a fix for ${path.join(project.dir, NESTED)}:4: cannot route research${path.sep}papers/ — only wiki/concepts, wiki/queries, or a single typed-entity directory are supported.`,
    });
    expect(targetReads(events)).toEqual([]);
  });

  it("P6 refuses a number that names no fix with the command's message, without reading any target", async () => {
    const events: string[] = [];
    for (const n of [0, OUT_OF_RANGE, 1.5, -1]) {
      expect(await proposeLintFixFrom(sourcesOver(events), n)).toEqual(indexRefusal(n));
    }
    expect(project.onDisk.outOfRange).toEqual(indexRefusal(OUT_OF_RANGE));
    expect(targetReads(events)).toEqual([]);
  });

  it("P7 reads the target once, after the plan walked the pages and asked for pending candidates", async () => {
    const { n } = proposalFor(project.onDisk.proposals, project.dir, LINKER);
    const events: string[] = [];
    await proposeLintFixFrom(sourcesOver(events), n);
    expect(targetReads(events)).toEqual([`target ${LINKER}`]);
    expect(events.at(-1)).toBe(`target ${LINKER}`);
    expect(events.filter((event) => event === `page ${LINKER}`)).toHaveLength(1);
    expect(events.findIndex((event) => event.startsWith("candidates "))).toBeGreaterThan(events.indexOf(`page ${LINKER}`));
  });

  it("P8 rejects with the target read's own error", async () => {
    const { n } = proposalFor(project.onDisk.proposals, project.dir, LINKER);
    const refusal = new Error("planted target read failure");
    await expect(proposeLintFixFrom(sourcesOver([], refusal), n)).rejects.toBe(refusal);
  });
});

/**
 * @file test/preparation-genericity.test.ts
 * @description Task 11's forbidden-identifier control: the core preparation
 * engine must carry NO product vocabulary. A domain profile (AutoSci / "AI
 * Research OS", Newsroom) is DATA — a `ProfilePack` the engine reads generically
 * — so an `experimentPlan` field, a `PaperSourceState` type, or even a comment
 * that explains a store "in terms of experiments" is drift evidence: it means
 * someone reasoned about the engine through one product's lens, and the next
 * edit will branch on it.
 *
 * WHAT THIS ADDS OVER THE EXISTING GATES. `test/genericity-grep-gate.test.ts`
 * and `test/no-research-branch-in-core.test.ts` already scan all of `src/`, but
 * both match only QUOTED STRING LITERALS in equality/`case` position, and the
 * first deliberately BLANKS comments. Neither can see a bare identifier
 * (`buildExperimentPlan`), a type name (`LiteratureReviewState`), or prose. This
 * control covers exactly that gap, on the surface where genericity is load
 * bearing, and is intentionally narrower in scope and wider in what it reads.
 *
 * MATCHING. Each line is segmented into lowercase alphanumeric tokens, splitting
 * on non-alphanumerics AND camelCase humps, then compared to the frozen
 * vocabulary as an exact CONSECUTIVE-TOKEN match. Segmentation — not substring
 * search — is what makes the check safe on this codebase: `history` does not
 * contain the token `story`, `authority` is not `author`, `abstraction` is not
 * `abstract`. It also means every spelling of one term collapses to one entry:
 * `literature-review`, `literatureReview`, `LITERATURE_REVIEW`, and
 * `"literature review"` all segment to the token pair `literature review`.
 *
 * EXEMPTIONS: none, deliberately. The frozen list below is itself product
 * vocabulary, but it lives in `test/`, and the scanned roots are under `src/`,
 * so the constant is out of scope by construction rather than by an allowlist
 * that could later be widened. Nothing under the scanned roots is exempted.
 *
 * This is a pure read gate: it opens no fixture, writes nothing, and edits no
 * `src/` file.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * SCOPE DECISION (the roots are chosen; every file under them is DERIVED).
 *
 * `src/preparations` is the preparation engine proper — its store, state,
 * problem, and validation modules. `src/operation-bundles` is scanned with it
 * because the two are one mutually-dependent surface, not neighbours:
 * `preparations/manifest-store.ts` reads through `operation-bundles/durable-leaf`
 * and `preparations/intent-request.ts` types itself on `OperationMutation`,
 * while `operation-bundles/lock-gate.ts` calls back into
 * `preparations/recovery.ts`. `operation-bundles/preparation-origin.ts` is the
 * handoff provenance record the preparation engine authors. A product term
 * leaking into either half compromises the same abstraction, so both are in.
 *
 * Nothing else is: profile TEMPLATES (`src/profile/templates/builtin/**`) are
 * where product vocabulary legitimately lives, and the rest of `src/` is already
 * covered for branch-shaped leaks by the two gates named in the file header.
 */
const SCANNED_ROOTS: readonly string[] = ["src/preparations", "src/operation-bundles"];

/**
 * Plausibility bounds on the DERIVED file set, so an empty-walk or wrong-root
 * bug cannot pass as a clean scan. The floor sits below today's 153 files (new
 * modules only push it up); the ceiling is far under `src/`'s ~710, so a root
 * that accidentally resolves to `src/` fails loudly instead of scanning
 * everything. `MIN_SCANNED_DIRECTORIES` proves the walk actually recursed
 * rather than reading only each root's top level.
 */
const MIN_SCANNED_FILES = 120;
const MAX_SCANNED_FILES = 400;
const MIN_SCANNED_DIRECTORIES = 4;

/**
 * THE FROZEN PRODUCT VOCABULARY — a human judgment, not a derivation.
 *
 * Which words count as "product vocabulary" cannot be computed from the tree:
 * the shipped profile packs are one source of these names, but the property
 * being frozen is "no product LENS in the engine", which is broader than any
 * pack's current contents. So this list is deliberately hand-chosen and frozen.
 * ADDING OR REMOVING AN ENTRY IS AN OWNER DECISION, not a fix for a red test —
 * if this gate fires, the default remedy is to rename the offending identifier
 * or reword the comment, and any change here must be justified in review.
 *
 * Entries are space-separated token sequences matched case-insensitively.
 * Single-token entries subsume their compounds after segmentation, which is why
 * e.g. `research-outputs`, `research-concepts`, and `ResearchOS` need no entry
 * of their own — `research` covers them.
 *
 * DELIBERATELY ABSENT, because each collides with core meaning on this surface
 * today: `citation` (the compiler's own `CitationRef` relation evidence),
 * `journal` (the crash-recovery page journal), `author` (the engine "authors" a
 * gate proof), `publication` (publishing evidence into the CAS), `protocol` (the
 * three-leg attempt protocol), `run log` (the hash-chained run log), and the
 * ordinary English profile entity names `sources`, `tests`, `methods`,
 * `reviews`, `people`, `ideas`, `topics`, `concepts`. Those remain covered as
 * quoted-literal branches by `test/no-research-branch-in-core.test.ts`.
 */
const FORBIDDEN_VOCABULARY: readonly string[] = [
  // Product and program names. `AutoSci` and `ResearchOS` each need TWO entries:
  // segmentation splits the camelCase form (`AutoSci` -> `auto sci`) but not the
  // flat form (`AUTOSCI_TEMPLATE`, `builtin/autosci.ts` -> `autosci`).
  "autosci",
  "auto sci",
  "researchos",
  "newsroom",
  // Research / "AI Research OS" domain vocabulary.
  "research",
  "researcher",
  "science",
  "scientific",
  "experiment",
  "experiments",
  "experimental",
  "paper",
  "papers",
  "manuscript",
  "manuscripts",
  "preprint",
  "preprints",
  "literature",
  "hypothesis",
  "hypotheses",
  "rebuttal",
  "peer review",
  // Research relation names (as segmented tokens, so `builds-on` matches too).
  "cites",
  "builds on",
  "addresses gap",
  "introduces concept",
  "proposes method",
  "extends method",
  // Newsroom domain vocabulary.
  "byline",
  "bylines",
  "desk",
  "desks",
  "story",
  "stories",
  "article",
  "articles",
  "filed under",
];

/** One product-vocabulary occurrence, reported as a clickable `file:line`. */
interface Violation {
  file: string;
  line: number;
  term: string;
  text: string;
}

/** The frozen vocabulary pre-split into the token sequences the matcher compares. */
const FORBIDDEN_TOKEN_SEQUENCES: readonly (readonly string[])[] = FORBIDDEN_VOCABULARY.map((term) =>
  term.split(" "),
);

/**
 * Segment one line into lowercase alphanumeric tokens. camelCase and
 * SCREAMING_CASE humps become boundaries so `buildExperimentPlan` yields
 * `experiment` while `history` never yields `story`.
 */
function tokenizeLine(line: string): string[] {
  return line
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether `want` appears as a consecutive run starting at `start` in `tokens`. */
function matchesAt(tokens: readonly string[], want: readonly string[], start: number): boolean {
  return want.every((token, offset) => tokens[start + offset] === token);
}

/**
 * Every forbidden term occurring in `text`. Comments and string literals are
 * scanned along with code: a comment that frames the engine in product terms is
 * the drift this control exists to catch, even when the code around it is
 * generic.
 */
function findForbiddenVocabulary(file: string, text: string): Violation[] {
  const out: Violation[] = [];
  text.split("\n").forEach((line, index) => {
    const tokens = tokenizeLine(line);
    for (const want of FORBIDDEN_TOKEN_SEQUENCES) {
      for (let start = 0; start + want.length <= tokens.length; start += 1) {
        if (!matchesAt(tokens, want, start)) continue;
        out.push({ file, line: index + 1, term: want.join(" "), text: line.trim() });
      }
    }
  });
  return out;
}

/**
 * Every `.ts` file under one repo-relative `root`, recursively, as repo-relative
 * forward-slash paths. Node's recursive `readdir` does not descend into symlinked
 * directories, so the scan cannot escape the root it was pointed at.
 */
function listTypeScriptFiles(root: string): string[] {
  return readdirSync(path.join(REPO_ROOT, root), { recursive: true, encoding: "utf8" })
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((relative) => relative.endsWith(".ts"))
    .map((relative) => `${root}/${relative}`);
}

/** The derived scan scope: every `.ts` file under every scanned root. */
function scannedFiles(): string[] {
  return SCANNED_ROOTS.flatMap(listTypeScriptFiles);
}

describe("preparation engine genericity", () => {
  it("derives a plausible, recursive scan scope from the tree", () => {
    const files = scannedFiles();
    const directories = new Set(files.map((file) => path.posix.dirname(file)));
    expect(files.length).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
    expect(files.length).toBeLessThanOrEqual(MAX_SCANNED_FILES);
    expect(directories.size).toBeGreaterThanOrEqual(MIN_SCANNED_DIRECTORIES);
  });

  it("covers every scanned root with at least one file", () => {
    const files = scannedFiles();
    for (const root of SCANNED_ROOTS) {
      expect(files.filter((file) => file.startsWith(`${root}/`)).length).toBeGreaterThan(0);
    }
  });

  it("catches product vocabulary in identifiers regardless of casing style", () => {
    const planted = [
      "export function buildExperimentPlan(): void {}",
      "const paper_source_metadata = 1;",
      "type LiteratureReviewState = { readonly stage: string };",
      "const RELATION = LOAD.filedUnder;",
      'import { AUTOSCI_TEMPLATE } from "../profile/templates/builtin/autosci.js";',
    ].join("\n");
    const hits = findForbiddenVocabulary("src/preparations/planted.ts", planted);
    expect(hits.map((hit) => `${hit.line}:${hit.term}`)).toEqual([
      "1:experiment",
      "2:paper",
      "3:literature",
      "4:filed under",
      "5:autosci",
      "5:autosci",
    ]);
  });

  it("catches product vocabulary in comments, not only in code", () => {
    const planted = [
      "/** Stage one experiment result into the evidence store. */",
      "// The newsroom desk owns this leg.",
      "const stage = 1; /* AutoSci callers rely on this ordering. */",
    ].join("\n");
    const hits = findForbiddenVocabulary("src/preparations/planted.ts", planted);
    expect(hits.map((hit) => `${hit.line}:${hit.term}`)).toEqual([
      "1:experiment",
      "2:newsroom",
      "2:desk",
      "3:auto sci",
    ]);
  });

  it("does not fire on core words that merely contain a forbidden term", () => {
    const legitimate = [
      "const history = await readRunHistory(root);",
      "if (!authoritative) throw new Error('authority is unavailable');",
      "* an abstraction for a case only sweep has",
      "import { JournalUnsafeError } from '../trust/journal-recovery.js';",
      "function relationEvidence(value: unknown): CitationRef[] {}",
      "* Authoritative publication into the preparation evidence CAS",
    ].join("\n");
    expect(findForbiddenVocabulary("src/preparations/legitimate.ts", legitimate)).toEqual([]);
  });

  it("keeps the frozen vocabulary free of duplicate and empty entries", () => {
    expect(new Set(FORBIDDEN_VOCABULARY).size).toBe(FORBIDDEN_VOCABULARY.length);
    expect(FORBIDDEN_VOCABULARY.filter((term) => term.trim() !== term || term === "")).toEqual([]);
  });

  it("the preparation engine contains no product vocabulary", () => {
    const violations = scannedFiles().flatMap((file) =>
      findForbiddenVocabulary(file, readFileSync(path.join(REPO_ROOT, file), "utf8")),
    );
    expect(violations.map((v) => `${v.file}:${v.line} [${v.term}] ${v.text}`)).toEqual([]);
  });
});

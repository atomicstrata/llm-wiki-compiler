/**
 * @file test/preparations/lifecycle-model/protocol-maps.test.ts
 * @description Mechanical gates on the Task 9D protocol-preservation map.
 *
 * Authority design V2 §5.1 states the property that gives the map its value:
 * "Every existing step appears exactly once as an owned driver step or an
 * operation-specific adapter obligation. Unmapped and multiply-owned steps fail
 * the design gate."
 *
 * A map is only worth writing if it cannot quietly drift from the code it maps,
 * so the checkable half is checked here rather than asserted in prose. Totality is
 * enforced against what the operation modules genuinely import, with every
 * non-step exclusion declared by name — coverage by operation LABEL passed while
 * the exact-object enumeration step was missing from the map entirely, which is
 * why that weaker check is not the totality control.
 *
 * Row PRESENCE is pinned as an exact set, not only row content. Audit showed 20
 * of 34 rows could be deleted with every control green — content was policed and
 * presence was not, so the map could shrink silently.
 *
 * What these controls still CANNOT do is verify that a row's crash classifications
 * or resume behaviour are TRUE. Those are review-only, and a green run here is not
 * evidence about them.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scenarioTitleIndex } from "./scenario-index.js";
import { FROZEN_REGRESSION_IDS } from "./frozen-regressions.js";
import { LIFECYCLE_COVERAGE_ROWS } from "./coverage-matrix.js";
import { RESET_QUARANTINE_PROTOCOL_MAP } from "./protocol-maps/reset-quarantine.js";
import { PRUNE_SWEEP_PROTOCOL_MAP } from "./protocol-maps/prune-sweep.js";
import { DISPOSITIONS, DRIVER_PHASES, PROTOCOL_OPERATIONS } from "./protocol-maps/types.js";
import { declaresSymbol, withoutComments } from "./source-text.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/**
 * Every map file, as one list. The controls below police THIS, not any single
 * file: a per-file control would make "add a new map file" the way to opt out of
 * id uniqueness, seam resolution, and the pinned row set.
 */
const RESET_QUARANTINE_PROTOCOL_MAP_ALL = [
  ...RESET_QUARANTINE_PROTOCOL_MAP, ...PRUNE_SWEEP_PROTOCOL_MAP,
];

/**
 * Names the two adapters import that are NOT protocol steps, so the exclusion is
 * reviewable rather than implicit. Each is a pure codec, an id mint, or a shape
 * probe with no durable effect and no decision of its own — the protocol steps
 * that USE them are mapped instead.
 *
 * A name may only be added here as a reviewed decision. Mutation testing confirms
 * why: adding a genuine step to this list hides it from the totality control just
 * as effectively as deleting its row. The list is the control's soft underbelly
 * and is kept short and explicit for exactly that reason.
 *
 * That failure mode arrived with the list. It first carried
 * `runLifecycleCustodyOperation` — the Task 9D driver entry point, the one new
 * protocol structure this task introduces — so the map excluded it BY NAME.
 * It is mapped now (PLA-MAP-D01). `readPreparationKey` was also redundant here,
 * since PLA-MAP-R04 names it in its seam.
 */
const NON_PROTOCOL_NAMES: readonly string[] = [
  "buildResetIntent", "parseResetIntent", "parsePendingResetKey", "signPendingResetKey",
  "verifyPendingResetKey", "matchesContinuationDigest", "resetContinuationDigest",
  "requiredResetConfirmation", "preparationKeyEpochId", "mintPreparationRunId",
  "quarantineCompletedReceiptStatus", "quarantineUnitConfinement",
  // Pure serialization. It produces the bytes a durable step writes; the step
  // itself is `writeResetUnitLeaf`, which is mapped. Surfaced only when the
  // extractor was widened past `./` — reset.ts reaches it through `../profile`,
  // so it had been neither mapped nor excluded, just unseen.
  "canonicalBytes",
  // An error class, imported as a runtime value only for `instanceof`. Surfaced
  // once type-ness stopped being inferred from capitalization.
  "PreparationLifecycleNamespaceError",
  // A TYPE-LEVEL TAG CONSTRUCTOR, not a step. `ungated` is `{...input,
  // authorization: "ungated"}` -- a pure spread adding a literal discriminant,
  // with no I/O and no durable effect. It exists so the three ungated callers
  // must CLAIM the exemption in the type rather than inherit it by omitting a
  // field, and the claim is what the driver reads; the marking itself does
  // nothing a protocol map could describe.
  //
  // Excluded as a reviewed decision, per this list's own warning: adding a
  // genuine step here hides it as effectively as deleting its row. Checked
  // against the implementation, not inferred from the name.
  "ungated",
  // Brand assertion. It narrows a string to a BundleId and touches nothing
  // durable; the step that USES the id is the handoff-bundle re-read in
  // PLA-MAP-PRN01, which is mapped.
  "assertBundleId",
  // Pure computation over an already-read manifest, used to build the run
  // binding. The durable read it depends on is `readPreparationManifest`,
  // mapped by PLA-MAP-SWP02.
  "preparationManifestDigest",
];

/** The destructive operation modules whose cross-module reach the map must cover. */
const MAPPED_OPERATION_MODULES = [
  "src/preparations/quarantine.ts", "src/preparations/reset.ts",
  "src/preparations/reset-intent-supersession.ts",
  // Added with the 9E map. Without it the totality gate never opens the module
  // that sequences prune and sweep, so the new rows would be policed for content
  // and not for completeness -- the same blindness that let an entire
  // enumeration step go unmapped before.
  "src/preparations/retention.ts",
];

/**
 * Modules that IMPLEMENT steps rather than sequencing them.
 *
 * The gate does not read these. They are the durable operations themselves, and
 * opening them would pull in the transitive filesystem infrastructure every step
 * uses — a far broader claim than "this operation reaches only mapped steps".
 */
const LEAF_STEP_MODULES: readonly string[] = [
  "src/preparations/key-epoch.ts",
  "src/preparations/lifecycle-driver.ts",
  "src/preparations/lifecycle-fs/quarantine-operations.ts",
  "src/preparations/lifecycle-fs/reset-operations.ts",
  "src/preparations/lifecycle-mutation-permit.ts",
  "src/preparations/lifecycle-snapshot/compat.ts",
  "src/preparations/orphan-scan.ts",
  "src/operation-bundles/manifest-store.ts",
  "src/preparations/lifecycle-fs/prune-protocol.ts",
  "src/preparations/prune-delete.ts",
  "src/preparations/quarantine-destroy.ts",
  "src/preparations/lifecycle-snapshot/postconditions.ts",
  "src/preparations/paths.ts",
  "src/preparations/lifecycle-snapshot/read.ts",
  // The shared sweep-target selector: a pure function over an already-captured
  // unit set, with no reach of its own. A LEAF rather than a composing module
  // for exactly that reason -- it sequences nothing.
  "src/preparations/lifecycle-snapshot/sweep-target.ts",
  "src/preparations/manifest-store.ts",
  "src/preparations/quarantine-move.ts",
  "src/preparations/receipts.ts",
  "src/preparations/run-store.ts",
  "src/utils/planned-bytes.ts",
];

/** One local import specifier's names, `type` and aliases stripped. */
function importedNames(block: string): string[] {
  // A whole-clause `import type { … }` brings in no runtime value, so nothing in
  // it can be a durable step.
  if (/^import\s+type\b/u.test(block.trim())) return [];
  const inner = block.match(/\{([^}]*)\}/s)?.[1] ?? "";
  return inner
    .split(",")
    .map((raw) => raw.trim())
    // Inline `type X` is likewise a type, not a step.
    .filter((raw) => !/^type\s/u.test(raw))
    .map((raw) => raw.split(/\s+as\s+/)[0]?.trim() ?? "")
    // Was `/^[a-z]/`, which used capitalization as a proxy for "value, not
    // type". It is a leaky proxy: a step exported as an uppercase const or a
    // class walked straight past the totality gate. Type-ness is now decided by
    // the `type` keyword, which is what actually determines it.
    .filter((name) => /^[A-Za-z]/u.test(name));
}

/** Every value name a module imports from a sibling preparation module. */
function localImportNames(source: string): string[] {
  // Any RELATIVE specifier, not just `./`. reset.ts already reaches a step
  // through `../profile/...`, which the narrower pattern silently skipped.
  const blocks = source.match(/import\s*\{([^}]*)\}\s*from\s*["']\.[^"']*["']/gs) ?? [];
  return blocks.flatMap(importedNames);
}

/**
 * Local imports in a mapped module that the name extractor cannot read.
 *
 * The totality gate derives what an operation reaches from its BRACED imports.
 * A namespace import or a dynamic import reaches just as far and is invisible to
 * that, so a brand-new durable step behind one stayed unmapped with the gate
 * green — reproduced, and the whole point of the gate is that a step cannot
 * leave the protocol unnoticed.
 *
 * The fix is not a cleverer extractor. It is to make the unreadable forms
 * ILLEGAL in exactly the two modules the gate reads, so braced extraction is
 * complete by construction. Neither module uses them today, so this costs
 * nothing now and refuses the evasion later.
 */
async function unreadableLocalImports(): Promise<string[]> {
  const offenders: string[] = [];
  for (const module of MAPPED_OPERATION_MODULES) {
    const source = withoutComments(await readFile(path.join(REPO_ROOT, module), "utf8"));
    if (/import\s+\*\s+as\s+\w+\s+from\s*["']\./u.test(source)) offenders.push(`${module}: namespace import`);
    if (/\bimport\s*\(\s*["']\./u.test(source)) offenders.push(`${module}: dynamic import`);
  }
  return offenders;
}

/** Every symbol the map cites. Structured, so prose can no longer count as one. */
function mappedSeamNames(): Set<string> {
  return new Set(RESET_QUARANTINE_PROTOCOL_MAP_ALL.flatMap((row) =>
    row.seam.map((citation) => citation.symbol)));
}

/** Cross-module names an operation module imports, minus the declared non-steps. */
async function unmappedOperationReach(): Promise<string[]> {
  const mapped = mappedSeamNames();
  const excluded = new Set(NON_PROTOCOL_NAMES);
  // Comment-stripped, like `unreadableLocalImports` just above it. Reading raw
  // source made a COMMENTED-OUT import count as a live reach.
  const sources = await Promise.all(MAPPED_OPERATION_MODULES.map(async (module) =>
    withoutComments(await readFile(path.join(REPO_ROOT, module), "utf8"))));
  const reached = new Set(sources.flatMap(localImportNames));
  return [...reached].filter((name) => !mapped.has(name) && !excluded.has(name)).sort();
}

describe("Task 9D protocol-preservation map", () => {
  it("gives every row a unique id", () => {
    const ids = RESET_QUARANTINE_PROTOCOL_MAP_ALL.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses only the closed vocabularies design V2 section 5.1 fixes", () => {
    const bad = RESET_QUARANTINE_PROTOCOL_MAP_ALL.filter((row) =>
      !DRIVER_PHASES.includes(row.phase) ||
      !DISPOSITIONS.includes(row.disposition) ||
      !PROTOCOL_OPERATIONS.includes(row.operation));
    expect(bad.map((row) => row.id)).toEqual([]);
  });

  it("declares every seam two rows share, so a new one cannot slip in", () => {
    // V2 section 5.1: a step appears exactly once. The check WAS keyed on a
    // row's whole seam set, and review defeated that by giving a second row one
    // extra citation alongside the seam it wanted to co-own.
    //
    // Keying per citation instead cries wolf, which is why it is not done here:
    // one function legitimately implements SEVERAL distinct steps.
    // `writeResetUnitLeaf` writes the intent leaf in R08 and the pending-key
    // leaf in R14 — different steps, different crash semantics, same helper.
    // What separates them is the step TEXT, which is a human judgement no
    // mechanical rule recovers.
    //
    // So the sharing is frozen as a reviewed list. Every symbol two rows share
    // in one phase is named below; anything else is a new co-ownership and fails
    // here, which is exactly the review moment the design gate wants.
    const owners = new Map<string, string[]>();
    for (const row of RESET_QUARANTINE_PROTOCOL_MAP_ALL) {
      for (const citation of row.seam) {
        const key = `${citation.symbol}@${citation.file}::${row.phase}`;
        owners.set(key, [...owners.get(key) ?? [], row.id]);
      }
    }
    const shared = [...owners.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([key, ids]) => `${key} owned by ${[...ids].sort().join(", ")}`)
      .sort();
    expect(shared).toEqual(REVIEWED_SHARED_SEAMS);

    // The list asserts these rows are DIFFERENT steps sharing one helper. That
    // claim is only as strong as what keeps the rows distinct, and the rows are
    // keyed by id — so if two of them converged on the same step text, the
    // frozen entry would still say "reviewed, these differ". Pin the property
    // the list actually claims.
    for (const [, ids] of [...owners.entries()].filter(([, list]) => list.length > 1)) {
      const steps = ids.map((id) =>
        RESET_QUARANTINE_PROTOCOL_MAP_ALL.find((row) => row.id === id)?.step);
      expect(new Set(steps).size).toBe(ids.length);
    }
  });

  it("requires a dated decision for every rejected step", () => {
    // A step may only leave the protocol through an argued record, never by
    // omission. This is the control that keeps the known post-mint gap honest.
    const unjustified = RESET_QUARANTINE_PROTOCOL_MAP_ALL
      .filter((row) => row.disposition === "rejected")
      // Was a bare `.includes(".md")`, which "nobody signed this.md" satisfied.
      // This is the identical defect fixed for provingTests one control down,
      // and it was still live here — so both now use the same dated-path rule.
      .filter((row) => row.rejectedBy === undefined || !DATED_DECISION.test(row.rejectedBy))
      .map((row) => row.id);
    expect(unjustified).toEqual([]);
  });

  it("cites proving evidence that actually exists", async () => {
    // A citation that resolves to nothing is decoration. Frozen ids must be real
    // frozen ids; scenario titles must name a real scenario; coverage ids must be
    // real rows. Document paths are review-only and are excluded deliberately.
    //
    // That exclusion was a bare `.includes(".md")`, which any scenario title
    // mentioning a markdown file would have satisfied — a free escape from the
    // whole check. Tightening it to `.endsWith` then broke both real document
    // citations, because each names a SECTION after the path. The rule has to
    // be the shape it is: a path, then `.md`, then a section or nothing.
    const frozen = new Set<string>(FROZEN_REGRESSION_IDS);
    const cases = new Set<string>(LIFECYCLE_COVERAGE_ROWS.map((row) => row.id));
    const titles = await scenarioTitleIndex(REPO_ROOT);
    const dangling: string[] = [];
    for (const row of RESET_QUARANTINE_PROTOCOL_MAP_ALL) {
      for (const cite of row.provingTests) {
        if (DOCUMENT_CITATION.test(cite)) continue;
        const known = frozen.has(cite) || cases.has(cite) || titles.has(cite);
        if (!known) dangling.push(`${row.id} -> ${cite}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it("resolves every seam citation to a declaration in that exact file", async () => {
    // Third revision of this control, because the first two were narrowed rather
    // than closed. Re-review defeated the previous form three ways, all green:
    // an identifier inside a docblock satisfied it; a citation's DIRECTORY was
    // discarded because sources were keyed by basename, and src/ carries ~70
    // duplicate basenames; and any symbol written in a shape the extractor did
    // not match was never checked at all — six rows carried such symbols.
    //
    // Seams are structured citations now, so there is no prose for a symbol to
    // hide in, paths are repo-relative, and comments are stripped before the
    // declaration test. Narrative lives in `seamNote`, which claims nothing.
    const unresolved: string[] = [];
    for (const row of RESET_QUARANTINE_PROTOCOL_MAP_ALL) {
      for (const { symbol, file } of row.seam) {
        const source = await readFile(path.join(REPO_ROOT, file), "utf8")
          .catch(() => "");
        if (!declaresSymbol(source, symbol)) unresolved.push(`${row.id}: ${symbol} not declared in ${file}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it("gives every row at least one resolvable citation", () => {
    // A row with no citations is checked by nothing. PLA-MAP-Q03 was exactly
    // that: its seam named the driver hop in prose, matched no citation shape,
    // and so was the one row the seam control verified zero symbols for.
    const uncited = RESET_QUARANTINE_PROTOCOL_MAP_ALL
      .filter((row) => row.seam.length === 0)
      .map((row) => row.id);
    expect(uncited).toEqual([]);
  });

  it("covers every destructive operation the migration touches", () => {
    // Totality in the only sense a test can enforce: no operation in scope is
    // absent from the map. It cannot prove the STEPS within an operation are
    // complete — that is the review's job, and the file header says so.
    const covered = new Set(RESET_QUARANTINE_PROTOCOL_MAP_ALL.map((row) => row.operation));
    expect([...PROTOCOL_OPERATIONS].filter((op) => !covered.has(op))).toEqual([]);
  });
  it("maps every protocol step the operations actually reach", async () => {
    // The totality claim, made mechanical. Coverage-by-operation-label cannot see a
    // MISSING production step — it passed while the exact-object enumeration step
    // was absent from the map entirely. This compares the map against what the
    // operation modules genuinely import, so a new cross-module step must either be
    // mapped or declared a non-step by name.
    expect(await unmappedOperationReach()).toEqual([]);
  });

  it("keeps the mapped modules readable by the totality gate", async () => {
    expect(await unreadableLocalImports()).toEqual([]);
  });

  it("classifies every module the map cites as composing or leaf", () => {
    // The gate extracts reach from the modules it READS. Supersession went
    // unchecked because its composing module was not one of them — the map
    // covered the operation while the gate never opened the file implementing
    // it, and a brand-new durable step behind that stayed invisible.
    //
    // A weaker version of this control was tried first and did not bite: it
    // asked whether each operation had ANY row citing a read module, and
    // supersession satisfied that incidentally through a row that also cites
    // reset.ts. Coverage by accident is not coverage.
    //
    // So every cited module must be explicitly one of two things. COMPOSING
    // modules sequence steps and must be read, or their reach is invisible.
    // LEAF modules ARE the steps; reading them would pull in transitive
    // infrastructure (measured: 54 names) and assert something far broader than
    // this gate means. A new module cited by a row is unclassified and fails
    // here, which forces the choice to be made rather than defaulted.
    const classified = new Set([...MAPPED_OPERATION_MODULES, ...LEAF_STEP_MODULES]);
    const unclassified = [...new Set(RESET_QUARANTINE_PROTOCOL_MAP_ALL
      .flatMap((row) => row.seam.map((citation) => citation.file))
      .filter((file) => !classified.has(file)))].sort();
    expect(unclassified).toEqual([]);
  });
  it("requires every row to actually say something in each mapped field", () => {
    // The row pin makes a row impossible to DELETE. It does nothing about a row
    // gutted in place: `step`, `effect`, `crashBefore`, `crashAfter` and
    // `resume` are the five fields design V2 §5.1 requires, and not one of them
    // was read by any control. Emptying all five of PLA-MAP-R12 — the known-gap
    // row — left the map green, which is the same "present but says nothing"
    // hole the pin was added to close, one level down.
    //
    // The bar is deliberately low, and the first draft of it was WRONG: a
    // twelve-character floor flagged 36 fields that were terse because they
    // were true. A pure-decision row genuinely leaves state "unchanged" with
    // resume "n/a", and padding those into sentences would make the map less
    // accurate to satisfy a test. Terseness is not the defect; absence is.
    //
    // So this catches erasure, not vagueness. No test can judge whether a crash
    // classification is CORRECT — that is why the map is reviewed and not
    // merely checked.
    const hollow = RESET_QUARANTINE_PROTOCOL_MAP_ALL.flatMap((row) => [
      ...(["step", "effect", "crashBefore", "crashAfter", "resume"] as const)
        .filter((field) => row[field].trim().length < SHORTEST_TRUE_CLASSIFICATION)
        .map((field) => `${row.id}.${field}`),
      // `step` is the row's whole subject and is never legitimately terse: the
      // shortest real one is 85 characters. Review gutted every other field to
      // the legal value "n/a" and left rows saying nothing, so the one field
      // that cannot be "n/a" carries its own floor.
      ...(row.step.trim().length < SHORTEST_REAL_STEP ? [`${row.id}.step (too terse to be a step)`] : []),
      // A row proved by nothing is a row nothing holds to account. Every row has
      // at least one citation today, so this costs nothing and closes the gap
      // review used to empty the list entirely.
      ...(row.provingTests.length === 0 ? [`${row.id}.provingTests (empty)`] : []),
    ]);
    expect(hollow).toEqual([]);
  });

  it("pins the exact row set, so a deletion is as visible as an addition", () => {
    // Row CONTENT was policed and row PRESENCE was not. Audit re-derived the
    // totality control and deleted rows one at a time: 20 of 34 could be removed
    // with every map control green — including PLA-MAP-R12, the KNOWN GAP row
    // whose whole purpose is to be present, and the entire S-block, which is the
    // shared custody protocol this migration exists to preserve.
    //
    // That made bdd6fee's claim that "a step cannot leave the protocol by
    // omission" false. This is the closure that makes it true, and it is the same
    // shape structural-controls.test.ts already applies to module roles.
    expect([...RESET_QUARANTINE_PROTOCOL_MAP_ALL].map((row) => row.id).sort()).toEqual([
      "PLA-MAP-D01",
      "PLA-MAP-P01",
      "PLA-MAP-P02",
      "PLA-MAP-PRN01",
      "PLA-MAP-PRN02",
      "PLA-MAP-PRN03",
      "PLA-MAP-PRN04",
      "PLA-MAP-PRN05",
      "PLA-MAP-PRN06",
      "PLA-MAP-PRN07",
      "PLA-MAP-PRN08",
      "PLA-MAP-PRN09",
      "PLA-MAP-PRN10",
      "PLA-MAP-PRN11",
      "PLA-MAP-Q01",
      "PLA-MAP-Q02",
      "PLA-MAP-Q03",
      "PLA-MAP-Q04",
      "PLA-MAP-Q05",
      "PLA-MAP-Q06",
      "PLA-MAP-R01",
      "PLA-MAP-R02",
      "PLA-MAP-R03",
      "PLA-MAP-R04",
      "PLA-MAP-R05",
      "PLA-MAP-R06",
      "PLA-MAP-R07",
      "PLA-MAP-R08",
      "PLA-MAP-R09",
      "PLA-MAP-R10",
      "PLA-MAP-R11",
      "PLA-MAP-R12",
      "PLA-MAP-R13",
      "PLA-MAP-R14",
      "PLA-MAP-R15",
      "PLA-MAP-R16",
      "PLA-MAP-R17",
      "PLA-MAP-R18",
      "PLA-MAP-R19",
      "PLA-MAP-R20",
      "PLA-MAP-R21",
      "PLA-MAP-R22",
      "PLA-MAP-S01",
      "PLA-MAP-S02",
      "PLA-MAP-S03",
      "PLA-MAP-S04",
      "PLA-MAP-S05",
      "PLA-MAP-S06",
      "PLA-MAP-SWP01",
      "PLA-MAP-SWP02",
      "PLA-MAP-SWP03",
      "PLA-MAP-SWP04",
      "PLA-MAP-SWP05",
    ]);
  });
});

/** The shortest classification the map legitimately contains, "n/a". */
const SHORTEST_TRUE_CLASSIFICATION = 3;

/** Comfortably under the shortest real step (85 chars), comfortably over "n/a". */
const SHORTEST_REAL_STEP = 40;

/** A review-only document reference: a path ending `.md`, plus an optional section. */
const DOCUMENT_CITATION = /^[\w./-]+\.md(?:\s|$)/u;

/**
 * Seams more than one row legitimately names, frozen after review.
 *
 * Each is one helper implementing genuinely distinct steps — different bytes,
 * different crash semantics — not a step with two owners.
 */
const REVIEWED_SHARED_SEAMS: readonly string[] = [
  "assertIntegrityInvalid@src/preparations/quarantine.ts::authorize owned by PLA-MAP-Q05, PLA-MAP-Q06",
  // Prune and quarantine now reach the SAME captured scan and the same run-scope
  // enumerator -- the uncaptured pair is deleted (§16 clause 3). The sharing is
  // wider than before and entirely intended: one enumeration, one gate.
  "enumerateRunScope@src/preparations/quarantine.ts::snapshot owned by PLA-MAP-PRN07, PLA-MAP-Q04",
  // Sweep selects its pending unit and refuses an unfinished PRUNE through the
  // same resolver: two different steps, one classifier, which is the point of
  // having a shared classifier at all.
  "pendingSweepUnitOf@src/preparations/retention.ts::observe owned by PLA-MAP-SWP01, PLA-MAP-SWP03",
  // One key read, three operations authorizing on it. Prune THROWS a typed
  // refusal here while sweep returns null -- recorded as an asymmetry in
  // PLA-MAP-SWP04 rather than smoothed over.
  "readPreparationKey@src/preparations/key-epoch.ts::authorize owned by PLA-MAP-PRN02, PLA-MAP-R04, PLA-MAP-SWP04",
  // Prune reads the run to decide eligibility; quarantine reads it to prove the
  // run is integrity-invalid. Same authenticated read, different precondition.
  "readPreparationRun@src/preparations/run-store.ts::authorize owned by PLA-MAP-PRN01, PLA-MAP-Q06",
  // The confinement proof and the completed-receipt short circuit are separate
  // steps that both live in the two-phase entry point.
  "runTwoPhaseVerifiedDelete@src/preparations/prune-delete.ts::observe owned by PLA-MAP-PRN04, PLA-MAP-PRN05",
  "scanForDestructivePlan@src/preparations/quarantine.ts::snapshot owned by PLA-MAP-PRN07, PLA-MAP-Q04",

  "settlePendingIntents@src/preparations/reset.ts::snapshot owned by PLA-MAP-R07, PLA-MAP-R19",
  "supersedeIntentOnlyUnitsLocked@src/preparations/reset-intent-supersession.ts::authorize owned by PLA-MAP-R01, PLA-MAP-R03",
  // The sweep entry point authorizes on TWO independent facts before it plans
  // anything: the key must read (SWP04) and this capture's unit must be the one
  // the gate authorized (SWP05). Different steps, one entry point, and neither
  // is the other's consequence.
  "sweepPreparationOrphansLocked@src/preparations/retention.ts::authorize owned by PLA-MAP-SWP04, PLA-MAP-SWP05",
  "writeResetUnitLeaf@src/preparations/lifecycle-fs/reset-operations.ts::plan owned by PLA-MAP-R08, PLA-MAP-R14",
];

/** A dated decision record: `<date>-<slug>.md`, optionally with a section. */
const DATED_DECISION = /(?:^|\/)\d{4}-\d{2}-\d{2}-[\w.-]+\.md(?:\s|$)/u;

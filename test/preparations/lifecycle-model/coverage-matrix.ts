/**
 * @file test/preparations/lifecycle-model/coverage-matrix.ts
 * @description Checked-in source of truth for the finite lifecycle model: one row per
 * modelled cell, each citing the real scenario that proves it.
 *
 * Rows are authored from the frozen corpus rather than invented, so a cell is claimed
 * covered only when a test actually exercises it. `frozenRegressionId` links a cell to
 * the historical reproduction behind it, which is what lets a later slice show it
 * preserved the behaviour instead of merely re-passing a renamed test.
 *
 * WHICH AXES ARE MACHINE-CHECKED. Only `consumer`, and only for the five consumers in
 * `CONSUMER_ENTRY_POINTS`: the suite asserts the cited scenario calls that entry point.
 * `driver`, `reset-planner` and `sweep-resumer` have no single seam and are unchecked.
 * The cited title is checked to exist and to name exactly one scenario. Rows sharing a
 * scenario are checked to agree on operation/state/registry/filesystemState/
 * recordState/objectState/crashPoint.
 *
 * A KNOWN RESIDUAL of the contradiction control: it groups by cited scenario TITLE,
 * so rows built from the same FIXTURE but citing different titles can still disagree
 * and go unreported. Four rows (031, 032, 034, 035) cite distinct scenarios all built
 * from `quarantineTampered({ afterMoves: crash })` and had `crashPoint: during-object`
 * while the same fixture is `after-objects` — corrected here, but found by a reviewer
 * reading fixtures, not by the control. 034 and 035 additionally claim objectState
 * `neither` where 031 claims `destination-only` from that same fixture; that ONE axis
 * is left alone deliberately, because behind a symlink swap it may be describing what
 * the consumer can OBSERVE rather than what physically exists, and the dimension does
 * not say which it means. Adjudicating that is open work, not something to guess at.
 * `recordState` is NOT contested: it is `absent` in 031 and in 034/035 alike, and it
 * varies legitimately across 031/032/033 because each scenario mutates the shared
 * fixture differently.
 *
 * Everything else is REVIEW-ONLY. For a row that is the sole citer of its scenario —
 * 64 of the 74 rows — those seven axes rest on the author having read the scenario.
 * A row can therefore still claim a cell its scenario does not exercise, which is what
 * a falsely certified capacity/prune-unavailable cell was. Treat the matrix as a
 * reviewed inventory with a few mechanical tripwires, not as a proof.
 */

import { coverageRow, type LifecycleCoverageRowV1 } from "./coverage-types.js";

/** Every modelled cell and the real test that proves it. */
export const LIFECYCLE_COVERAGE_ROWS: readonly LifecycleCoverageRowV1[] = [
  // --- quarantine: ordinary custody, resume, and the states around completion ---
  coverageRow("PLA-CASE-001", ["quarantine", "completed", "quarantine", "object", "regular", "valid-completed", "destination-only", "after-completion", "driver", "none"], "moves an integrity-invalid run byte-for-byte and stops counting it as active", "PLA-REG-QTN-001"),
  coverageRow("PLA-CASE-002", ["quarantine", "completed", "quarantine", "unit", "regular", "valid-completed", "destination-only", "after-objects", "driver", "settle"], "is idempotent: a re-run resumes the same unit and returns the same objects", "PLA-REG-QTN-002"),
  coverageRow("PLA-CASE-003", ["quarantine", "inert", "quarantine", "unit", "absent", "absent", "neither", "before-plan", "driver", "none"], "refuses a valid run, a missing confirmation, and a missing key", "PLA-REG-QTN-003"),
  coverageRow("PLA-CASE-004", ["quarantine", "planned", "quarantine", "object", "regular", "valid-planned", "source-only", "after-plan", "driver", "none"], "refuses a fresh plan whose source changed after the plan became durable", "PLA-REG-QTN-007"),
  coverageRow("PLA-CASE-005", ["quarantine", "applying", "quarantine", "object", "regular", "valid-planned", "both-conflict", "during-object", "driver", "complete"], "refuses to complete when planned bytes sit at the destination beside a live source", "PLA-REG-QTN-008"),
  coverageRow("PLA-CASE-006", ["quarantine", "applying", "quarantine", "object", "regular", "valid-planned", "both-same", "during-object", "driver", "complete"], "completes a commit interrupted after the link but before the source unlink", "PLA-REG-QTN-010"),
  coverageRow("PLA-CASE-007", ["quarantine", "completed", "quarantine", "object", "regular", "valid-completed", "destination-only", "after-completion", "driver", "none"], "quarantines evidence larger than the old private hash ceiling", "PLA-REG-QTN-009"),
  coverageRow("PLA-CASE-008", ["quarantine", "unavailable", "quarantine", "registry", "unreadable", "absent", "neither", "before-plan", "driver", "none"], "refuses to plan a destructive scope from an incomplete inventory", "PLA-REG-QTN-011"),
  coverageRow("PLA-CASE-009", ["quarantine", "unavailable", "quarantine", "unit", "empty-directory", "absent", "neither", "before-plan", "driver", "none"], "reads an empty unit directory as inert rather than pending"),
  coverageRow("PLA-CASE-010", ["quarantine", "unavailable", "quarantine", "registry", "non-directory", "absent", "neither", "before-plan", "driver", "none"], "reads a non-directory registry entry as unavailable rather than skipping it"),

  // --- purge: exact-object deletion, confinement, and forged settlement ---
  coverageRow("PLA-CASE-011", ["purge", "completed", "quarantine", "bytes-staging", "regular", "valid-completed", "destination-only", "after-completion", "driver", "delete"], "destroys only a complete unit's bytes and retains the receipt tombstone", "PLA-REG-QTN-004"),
  coverageRow("PLA-CASE-012", ["purge", "completed", "quarantine", "unit", "regular", "valid-completed", "destination-only", "after-completion", "driver", "none"], "refuses a purge without the destroy confirmation", "PLA-REG-QTN-005"),
  coverageRow("PLA-CASE-013", ["purge", "inert", "quarantine", "unit", "absent", "absent", "neither", "before-plan", "driver", "none"], "refuses to purge an incomplete unit", "PLA-REG-QTN-006"),
  coverageRow("PLA-CASE-014", ["purge", "unavailable", "quarantine", "unit", "symlink", "valid-completed", "destination-only", "after-completion", "driver", "delete"], "refuses to purge through a unit symlinked out of the project, deleting nothing", "PLA-REG-QTN-012"),
  coverageRow("PLA-CASE-015", ["purge", "unavailable", "quarantine", "receipt", "regular", "copied-planned", "destination-only", "after-completion", "driver", "settle"], "refuses to purge on a signed planned receipt copied over the completed name", "PLA-REG-QTN-013"),

  // --- reset: the two-invocation protocol and its pre-plan states ---
  coverageRow("PLA-CASE-016", ["reset", "awaiting-continuation-intent-only", "quarantine", "unit", "regular", "absent", "neither", "before-plan", "reset-planner", "none"], "records an intent and returns a continuation secret on the first pass", "PLA-REG-RST-001"),
  coverageRow("PLA-CASE-017", ["reset", "completed", "quarantine", "object", "regular", "valid-completed", "destination-only", "after-completion", "reset-planner", "none"], "quarantines all authority and installs one fresh epoch on the token-bearing rerun", "PLA-REG-RST-002"),
  coverageRow("PLA-CASE-018", ["reset", "awaiting-continuation-intent-only", "quarantine", "unit", "regular", "absent", "neither", "before-plan", "driver", "authorize"], "supersedes a pending intent only when explicitly asked, invalidating its token", "PLA-REG-RST-004"),
  coverageRow("PLA-CASE-019", ["reset", "inert", "quarantine", "unit", "absent", "absent", "neither", "before-plan", "reset-planner", "none"], "refuses to reset a healthy key epoch", "PLA-REG-RST-007"),
  coverageRow("PLA-CASE-020", ["reset", "completed", "quarantine", "receipt", "absent", "valid-completed", "neither", "after-completion", "driver", "delete"], "removes the plaintext staged key and the intent marker once the reset completes", "PLA-REG-RST-008"),
  coverageRow("PLA-CASE-021", ["reset", "completed", "prune", "bytes-staging", "regular", "valid-completed", "source-only", "after-completion", "reset-planner", "none"], "takes custody of sweep bytes staged under the epoch it replaces", "PLA-REG-RST-009"),
  coverageRow("PLA-CASE-022", ["reset", "unavailable", "prune", "unit", "symlink", "absent", "neither", "before-plan", "reset-planner", "none"], "refuses the reset when a prune unit is an empty symlink rather than a real directory", "PLA-REG-RST-010"),
  coverageRow("PLA-CASE-023", ["reset", "awaiting-continuation-intent-only", "quarantine", "unit", "regular", "absent", "neither", "before-plan", "capacity", "none"], "refuses a planted reset-intent while the key is healthy and quarantines nothing", "PLA-REG-RST-013"),
  coverageRow("PLA-CASE-024", ["reset", "awaiting-continuation-materialized", "quarantine", "unit", "regular", "valid-planned", "neither", "after-plan", "driver", "none"], "refuses a token-bearing rerun when the key is restored between the two invocations", "PLA-REG-RST-014"),
  coverageRow("PLA-CASE-025", ["reset", "unavailable", "quarantine", "receipt", "regular", "wrong-binding", "neither", "before-plan", "driver", "authorize"], "refuses a token whose intent was copied into another unit", "PLA-REG-RST-015"),
  coverageRow("PLA-CASE-026", ["reset", "unavailable", "quarantine", "receipt", "regular", "corrupt-completed", "neither", "after-plan", "driver", "settle"], "refuses a signed planned receipt copied over the completed receipt name", "PLA-REG-RST-016"),
  coverageRow("PLA-CASE-027", ["reset", "unavailable", "quarantine", "unit", "unreadable", "absent", "neither", "before-plan", "reset-planner", "none"], "refuses a new intent when an existing unit is unreadable rather than assuming none", "PLA-REG-RST-017"),
  coverageRow("PLA-CASE-028", ["reset", "awaiting-continuation-materialized", "quarantine", "object", "regular", "valid-planned", "source-only", "after-plan", "driver", "none"], "resumes a reset that crashed after publishing the active key and completes", "PLA-REG-RST-018"),
  coverageRow("PLA-CASE-029", ["reset", "planned", "quarantine", "bytes-staging", "regular", "valid-planned", "source-only", "before-plan", "driver", "none"], "moves the unreadable key into quarantine before minting a fresh epoch", "PLA-REG-RST-020"),

  // --- references and GC: both registries must reach the same conclusion ---
  coverageRow("PLA-CASE-030", ["quarantine", "planned", "quarantine", "unit", "regular", "valid-planned", "source-only", "after-plan", "references", "none"], "fails closed while a destructive quarantine unit is pending", "PLA-REG-REF-005"),
  coverageRow("PLA-CASE-031", ["quarantine", "applying", "quarantine", "receipt", "absent", "absent", "destination-only", "after-objects", "references", "settle"], "a deleted planned receipt stays pending, never silently settled", "PLA-REG-REF-007"),
  coverageRow("PLA-CASE-032", ["quarantine", "applying", "quarantine", "receipt", "regular", "corrupt-planned", "destination-only", "after-objects", "references", "historical"], "a corrupted planned receipt stays pending, never silently historical", "PLA-REG-REF-008"),
  coverageRow("PLA-CASE-033", ["quarantine", "unavailable", "quarantine", "registry", "unreadable", "valid-planned", "destination-only", "after-objects", "references", "none"], "an unreadable unit or registry reads unavailable, never clean", "PLA-REG-REF-009"),
  coverageRow("PLA-CASE-034", ["quarantine", "unavailable", "quarantine", "unit", "symlink", "absent", "neither", "after-objects", "gc", "none"], "a unit replaced by a symlink reads unavailable, never clean", "PLA-REG-REF-011"),
  coverageRow("PLA-CASE-035", ["quarantine", "unavailable", "quarantine", "registry", "redirected", "absent", "neither", "after-objects", "gc", "none"], "a registry root replaced by a symlink reads unavailable, never clean", "PLA-REG-REF-012"),
  coverageRow("PLA-CASE-036", ["reset", "historical", "quarantine", "unit", "regular", "stale-epoch", "neither", "after-completion", "references", "historical"], "a unit retired by a completed reset reads historical, so references stay complete", "PLA-REG-REF-013"),
  coverageRow("PLA-CASE-037", ["quarantine", "unavailable", "quarantine", "object", "regular", "wrong-binding", "unreadable", "before-plan", "references", "none"], "fails closed on an integrity-invalid owner", "PLA-REG-REF-004"),

  // --- prune and sweep: the second registry, seen by every shared consumer ---
  coverageRow("PLA-CASE-038", ["sweep", "applying", "prune", "unit", "regular", "valid-planned", "source-only", "during-object", "status", "none"], "a crashed sweep is visible to the lifecycle gate and blocks reference completeness", "PLA-REG-PRN-016"),
  coverageRow("PLA-CASE-039", ["sweep", "applying", "prune", "unit", "regular", "valid-planned", "source-only", "during-object", "gc", "none"], "a crashed sweep is visible to the lifecycle gate and blocks reference completeness", "PLA-REG-PRN-016"),
  coverageRow("PLA-CASE-040", ["sweep", "applying", "prune", "unit", "regular", "valid-planned", "source-only", "during-object", "references", "none"], "a crashed sweep is visible to the lifecycle gate and blocks reference completeness", "PLA-REG-PRN-016"),
  coverageRow("PLA-CASE-041", ["sweep", "applying", "prune", "unit", "regular", "valid-planned", "source-only", "during-object", "recovery", "none"], "a crashed sweep is visible to the lifecycle gate and blocks reference completeness", "PLA-REG-PRN-016"),
  coverageRow("PLA-CASE-042", ["sweep", "applying", "prune", "unit", "regular", "valid-planned", "source-only", "during-object", "sweep-resumer", "none"], "resumes its own pending unit after a staging crash instead of deriving a new one", "PLA-REG-PRN-012"),
  coverageRow("PLA-CASE-043", ["sweep", "unavailable", "prune", "unit", "regular", "absent", "source-only", "during-object", "sweep-resumer", "settle"], "refuses to derive a new sweep when staged bytes have lost their planned receipt", "PLA-REG-PRN-013"),
  coverageRow("PLA-CASE-044", ["sweep", "unavailable", "prune", "object", "regular", "absent", "source-only", "during-object", "sweep-resumer", "delete"], "refuses a renamed staged leaf just as it refuses a prefixed one", "PLA-REG-PRN-014"),
  coverageRow("PLA-CASE-045", ["sweep", "unavailable", "prune", "registry", "symlink", "absent", "neither", "before-plan", "sweep-resumer", "none"], "refuses to derive a sweep when the prune registry root is a symlink", "PLA-REG-PRN-015"),
  coverageRow("PLA-CASE-046", ["sweep", "unavailable", "prune", "registry", "unreadable", "absent", "neither", "before-plan", "sweep-resumer", "delete"], "refuses to sweep from a partial inventory instead of deleting what it can see", "PLA-REG-PRN-010"),
  coverageRow("PLA-CASE-047", ["prune", "planned", "prune", "object", "regular", "valid-planned", "source-only", "after-plan", "driver", "delete"], "refuses a fresh prune whose target changed after the plan became durable", "PLA-REG-PRN-005"),
  coverageRow("PLA-CASE-048", ["prune", "applying", "prune", "bytes-staging", "regular", "valid-planned", "destination-only", "during-object", "driver", "delete"], "resumes a prune that crashed between staging and unlinking, leaving no staged bytes", "PLA-REG-PRN-007"),
  coverageRow("PLA-CASE-049", ["prune", "unavailable", "prune", "unit", "redirected", "valid-planned", "source-only", "after-plan", "driver", "delete"], "refuses to stage into a prune unit replaced by a symlink out of the project", "PLA-REG-PRN-008"),
  coverageRow("PLA-CASE-050", ["prune", "applying", "prune", "object", "absent", "valid-planned", "neither", "after-objects", "driver", "delete"], "resumes a prune interrupted after the deletes", "PLA-REG-PRN-009"),
  coverageRow("PLA-CASE-051", ["prune", "completed", "prune", "object", "absent", "valid-completed", "neither", "after-completion", "driver", "delete"], "deletes an eligible run's exact bytes and keeps a tombstone", "PLA-REG-PRN-003"),
  coverageRow("PLA-CASE-052", ["prune", "inert", "prune", "unit", "absent", "absent", "neither", "before-plan", "driver", "none"], "is eligible only for a terminal run past the injectable retention floor", "PLA-REG-PRN-001"),
  coverageRow("PLA-CASE-053", ["prune", "inert", "prune", "unit", "absent", "absent", "neither", "before-plan", "driver", "none"], "is never eligible for a recovery-required run", "PLA-REG-PRN-002"),
  coverageRow("PLA-CASE-054", ["sweep", "completed", "prune", "object", "absent", "valid-completed", "neither", "after-completion", "sweep-resumer", "delete"], "reclaims a manifest whose run leaf is provably absent", "PLA-REG-PRN-011"),
  coverageRow("PLA-CASE-055", ["sweep", "unavailable", "prune", "unit", "unreadable", "absent", "unreadable", "before-plan", "sweep-resumer", "none"], "never sweeps an integrity-invalid run whose owner is unreadable", "PLA-REG-PRN-017"),
  coverageRow("PLA-CASE-056", ["quarantine", "unavailable", "quarantine", "unit", "unreadable", "valid-planned", "destination-only", "after-objects", "recovery", "none"], "an unreadable unit or registry reads unavailable, never clean", "PLA-REG-REF-009"),
  coverageRow("PLA-CASE-057", ["prune", "unavailable", "prune", "registry", "redirected", "absent", "neither", "before-plan", "status", "none"], "holds status, reference completeness, and the sweep driver fail-closed"),
  coverageRow("PLA-CASE-058", ["prune", "unavailable", "prune", "registry", "redirected", "absent", "neither", "before-plan", "references", "none"], "holds status, reference completeness, and the sweep driver fail-closed"),
  // The capacity/prune-unavailable cell. Its previous citation exercised a tampered
  // ACTIVE run: the consumer-entry-point control passed because that scenario does
  // call `scanPreparationInventory`, but nothing in it made the PRUNE registry
  // unavailable, so the cell was certified by a scenario about a different subject.
  // The row now cites a scenario whose subject IS an unbindable prune registry and
  // whose capacity result is asserted exactly (`problems` equals the empty list).
  coverageRow("PLA-CASE-059", ["prune", "unavailable", "prune", "registry", "redirected", "absent", "neither", "before-plan", "capacity", "none"], "keeps staging and a real handoff settlement working"),

  // --- crash resumption seen by recovery, across both custody engines ---
  coverageRow("PLA-CASE-061", ["quarantine", "applying", "quarantine", "receipt", "regular", "valid-planned", "source-only", "after-plan", "recovery", "none"], "resumes after a crash following the planned receipt without byte loss", "PLA-REG-RACE-001"),
  coverageRow("PLA-CASE-062", ["quarantine", "applying", "quarantine", "object", "regular", "valid-planned", "destination-only", "after-objects", "driver", "none"], "resumes after a crash following the moves and never re-trusts the run", "PLA-REG-RACE-002"),
  coverageRow("PLA-CASE-063", ["reset", "awaiting-continuation-materialized", "quarantine", "unit", "regular", "valid-planned", "source-only", "after-plan", "driver", "none"], "reuses a fresh key minted before a crash and completes on the rerun", "PLA-REG-RACE-003"),
  coverageRow("PLA-CASE-064", ["reset", "applying", "quarantine", "object", "regular", "valid-planned", "both-same", "during-object", "driver", "complete"], "moves every scoped byte exactly once across a mid-move crash", "PLA-REG-RACE-004"),
  coverageRow("PLA-CASE-065", ["reset", "completed", "quarantine", "receipt", "regular", "valid-completed", "neither", "before-completion", "driver", "none"], "a resumed reset signs the planned retirement digests, not a re-enumeration", "PLA-REG-REF-014"),
  coverageRow("PLA-CASE-066", ["quarantine", "applying", "quarantine", "object", "regular", "valid-planned", "source-only", "before-completion", "driver", "none"], "a resumed quarantine refuses to move a source that changed since the plan", "PLA-REG-REF-010"),

  // --- V3 supported exit: added here, after its behaviour existed, not before ---
  coverageRow("PLA-CASE-070", ["reset", "awaiting-continuation-intent-only", "quarantine", "unit", "regular", "absent", "neither", "before-plan", "driver", "authorize"], "clears a stale intent and leaves the lifecycle usable again"),
  coverageRow("PLA-CASE-071", ["reset", "awaiting-continuation-materialized", "quarantine", "unit", "regular", "valid-planned", "neither", "before-plan", "driver", "none"], "refuses a unit holding staged pending-key material"),
  coverageRow("PLA-CASE-072", ["reset", "awaiting-continuation-materialized", "quarantine", "bytes-staging", "regular", "absent", "source-only", "before-plan", "driver", "none"], "refuses a unit holding an owned old-key custody object"),
  coverageRow("PLA-CASE-073", ["reset", "awaiting-continuation-intent-only", "quarantine", "unit", "empty-directory", "absent", "neither", "before-plan", "driver", "authorize"], "accepts a unit holding only an empty owned bytes directory"),
  coverageRow("PLA-CASE-074", ["reset", "unavailable", "quarantine", "unit", "unreadable", "absent", "neither", "before-plan", "driver", "none"], "refuses a unit it cannot examine"),

  coverageRow("PLA-CASE-075", ["quarantine", "applying", "quarantine", "unit", "regular", "valid-planned", "source-only", "after-plan", "status", "none"], "resumes after a crash following the planned receipt without byte loss", "PLA-REG-RACE-001"),

  // --- the project namespace itself: absence proved only under a trusted parent ---
  coverageRow("PLA-CASE-067", ["quarantine", "unavailable", "quarantine", "llmwiki", "unreadable", "absent", "neither", "before-plan", "driver", "none"], "proves absence only on ENOENT and reports every other fault as unavailable", "PLA-REG-PRS-001"),
  coverageRow("PLA-CASE-069", ["quarantine", "applying", "quarantine", "bytes-staging", "regular", "valid-planned", "destination-only", "after-objects", "capacity", "none"], "accounts for bytes held by an unfinished quarantine rather than losing them"),
  coverageRow("PLA-CASE-068", ["prune", "inert", "prune", "llmwiki", "absent", "absent", "neither", "before-plan", "driver", "none"], "distinguishes an absent directory from an unreadable one", "PLA-REG-PRS-002"),
];

/**
 * @file src/preparations/service-list.ts
 * @description The `list` operation — enumerate preparation runs and the
 * lifecycle problems observed while reading them. Design v10 §5 row 2.
 *
 * Read-only and GRANT-FREE (D-10-13): it takes no lock, writes no byte, and
 * charges no grant, so no principal is resolved for it. Adding one would assert
 * an authority decision the operation does not make.
 *
 * D-10-4 IS THE WHOLE SHAPE OF THIS FILE. "Could not read" and "does not
 * qualify" are distinct at every read leg: a manifest names a run that MUST
 * exist, so a failed read is "could not see", never "does not exist", and the
 * distinction is carried in `detail` rather than collapsed into an absent row.
 * An operator deciding whether to act needs to know which one they are looking
 * at, and so does every other surface.
 */

import { scanPreparationInventory } from "./capacity.js";
import { readPreparationKey } from "./key-epoch.js";
import type { PreparationManifestV1 } from "./manifest-parse.js";
import { bindingFor } from "./references.js";
import { readPreparationRun } from "./run-store.js";
import { resolvePreparationReadReadiness } from "./service-readiness.js";
import type { ReadReadinessV1 } from "./service-readiness.js";
import type { PreparationRunBinding, PreparationRunState } from "./run-types.js";

/** One enumerated preparation run. */
export interface PreparationRunRowV1 {
  readonly workspaceId: string;
  readonly preparationId: string;
  readonly runId: string;
  readonly state: PreparationRunState | null;
  /** Why the run could not be read, when `state` is null. */
  readonly detail: string | null;
}

/**
 * The deterministic response cap (design v10 §6).
 *
 * Following the shipped `MAX_STATUS_LIST = 100` precedent. This is a RESPONSE
 * bound and is deliberately not the traversal bound: work is already bounded by
 * the host-owned `MAX_PREPARATION_INVENTORY_ENTRIES = 100_000`, and conflating
 * the two would silently turn a big store into a short answer with no signal.
 * Every run is still read and still accounted for; only the response is capped,
 * and it says so.
 */
export const MAX_PREPARATION_LIST_ITEMS = 100;

/**
 * The whole answer, shaped so every surface renders one source.
 *
 * BOUNDED, WITH TOTALS AND A FLAG. §6 requires a deterministic response cap
 * carrying the true total and `truncated`. Runs and problems are bounded
 * SEPARATELY, each with its own pair: §6 explicitly refuses to exempt problems
 * from the cap (a store's problem list is attacker-influenceable and would
 * otherwise grow toward the traversal ceiling), and it gives them their own
 * total/truncation signal rather than folding them into the run counters.
 *
 * NAMING NOTE: §6 calls the problem counters `blockingTotal` /
 * `blockingTruncated` for the joined status projection, whose problems are
 * typed `PreparationLifecycleProblemV1` records classified as blocking. This
 * operation's problems are formatted observation strings and none of them is a
 * blocking classification, so reusing those names would claim a semantic this
 * shape does not have. The bound and the signal are §6's; the names are honest
 * about which problem family they count.
 */
export interface ListResultV1 {
  /** At most {@link MAX_PREPARATION_LIST_ITEMS} rows, in the deterministic order. */
  readonly runs: readonly PreparationRunRowV1[];
  /** Every run accounted for, before the cap. */
  readonly total: number;
  /** True when `runs` omits rows the store holds. */
  readonly truncated: boolean;
  /** At most {@link MAX_PREPARATION_LIST_ITEMS} problems. */
  readonly problems: readonly string[];
  /** Every problem observed, before the cap. */
  readonly problemTotal: number;
  /** True when `problems` omits problems that were observed. */
  readonly problemsTruncated: boolean;
}

/**
 * The preparation listing comparator: creation time DESCENDING, then run id
 * ascending (D-10-5).
 *
 * ITS ONE HOME. D-10-5 requires exactly one, imported everywhere and
 * re-implemented nowhere; at this baseline no other module had written one, so
 * this is it rather than a second copy. The tie-break on the typed id is what
 * makes truncation reproducible — two manifests minted in the same millisecond
 * would otherwise order by whatever the directory walk happened to yield, and a
 * cap over an unstable order drops a different run each run.
 */
export function comparePreparationListing(
  left: { readonly createdAt: string; readonly runId: string },
  right: { readonly createdAt: string; readonly runId: string },
): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
  return left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0;
}

/**
 * Apply the response cap, RESERVING HEADROOM for the derived problems.
 *
 * THE TWO PROBLEM FAMILIES ARE NOT INTERCHANGEABLE, and treating them as one
 * list was a regression this function introduced. `derived` holds the
 * run-accounting cross-check and the key-status line — the signals that say "I
 * could not account for the runs I can see". `observed` holds one entry per
 * problem the scan met, and manifest leaves are filesystem-plantable: a hundred
 * junk manifests produce a hundred `manifest-state` entries. Concatenating them
 * and slicing meant the plantable family evicted the accounting signal, and the
 * answer became `runs: [], total: 0, truncated: false` with run bytes on disk
 * and nothing saying so — the exact silently-empty answer the cross-check
 * exists to prevent.
 *
 * STRUCTURAL, NOT POSITIONAL. Ordering `derived` first would also have fixed
 * it, and would have been one edit away from breaking again the next time
 * somebody appends a problem source. Here `derived` is never passed to a
 * `slice` at all: only `observed` is capped, to whatever room is left. §6's own
 * principle, one shape over — the thing an operator is diagnosing must not be
 * the thing the sample dropped.
 *
 * `derived` is bounded by CONSTRUCTION at five entries (three accounting pushes,
 * at most one key line, at most one project-readiness line), so reserving all of
 * it cannot itself breach the cap. That bound is a claim about the callers, not
 * about this function — a new derived source has to re-check it here.
 */
function bounded(
  rows: readonly PreparationRunRowV1[],
  derived: readonly string[], observed: readonly string[],
): ListResultV1 {
  const headroom = Math.max(0, MAX_PREPARATION_LIST_ITEMS - derived.length);
  return {
    runs: rows.slice(0, MAX_PREPARATION_LIST_ITEMS),
    total: rows.length,
    truncated: rows.length > MAX_PREPARATION_LIST_ITEMS,
    problems: [...derived, ...observed.slice(0, headroom)],
    problemTotal: derived.length + observed.length,
    problemsTruncated: observed.length > headroom,
  };
}

/** Why one run could not be read, in the could-not-see / does-not-exist taxonomy. */
function unreadableDetail(read: Awaited<ReturnType<typeof readPreparationRun>>): string | null {
  if (read.status === "ok") return null;
  return read.status === "absent" ? "manifest names an absent run" : read.code;
}

/** Read one manifest's run into a row. */
async function readRow(
  root: string, manifest: PreparationManifestV1,
  keyEpochId: PreparationRunBinding["keyEpochId"],
): Promise<PreparationRunRowV1> {
  const read = await readPreparationRun(root, bindingFor(manifest, keyEpochId));
  return {
    workspaceId: manifest.workspaceId, preparationId: manifest.preparationId,
    runId: manifest.runId,
    state: read.status === "ok" ? read.run.state : null,
    detail: unreadableDetail(read),
  };
}

/** Read every run the inventory names, under the active key epoch. */
async function readRows(
  // The BRANDED epoch, not `string`: widening it here would let any string
  // stand in for the authority the binding is built from, which is the one
  // thing a run read must not accept loosely.
  root: string, manifests: readonly PreparationManifestV1[],
  keyEpochId: PreparationRunBinding["keyEpochId"],
): Promise<readonly PreparationRunRowV1[]> {
  const rows: PreparationRunRowV1[] = [];
  for (const manifest of manifests) {
    rows.push(await readRow(root, manifest, keyEpochId));
  }
  return rows;
}

/**
 * Cross-check the listing against the scan's OWN run count.
 *
 * The rows come from `inventory.manifests`; the scan separately counts the run
 * leaves it saw. Four states make those disagree while every other signal reads
 * healthy — a deleted preparation directory with its run leaf intact, a
 * `manifest.json.tmp` crash alias, a workspace directory whose id is
 * unverifiable (the scanner IGNORES those by design, for co-located Milestone A
 * subtrees), and a manifest whose run leaf is gone. In the first three the
 * answer was `{"runs": [], "problems": []}` with run bytes on disk.
 *
 * It was holding the contradiction the whole time and throwing it away:
 * `inventory.epoch.runs.count` refutes the answer directly. Comparing them is
 * the difference between "there are no runs" and "I could not account for the
 * runs I can see", and only the second is honest.
 */
function unlistedRunProblems(
  inventory: Awaited<ReturnType<typeof scanPreparationInventory>>,
  rows: readonly PreparationRunRowV1[],
): readonly string[] {
  const problems: string[] = [];
  const seen = inventory.epoch.runs.count;
  if (seen > rows.length) {
    problems.push(
      `run-accounting: the scan saw ${seen} run leaves but only ${rows.length} could be listed`);
  }
  if (inventory.epoch.orphans.count > 0) {
    problems.push(`run-accounting: ${inventory.epoch.orphans.count} orphaned preparation leaves`);
  }
  // A manifest names a run that MUST exist, so an absent one is a store
  // problem, not merely a per-row note. It reached `detail` only, leaving
  // `problems: []` to read as "store healthy".
  const absent = rows.filter((row) => row.detail === "manifest names an absent run").length;
  if (absent > 0) problems.push(`run-accounting: ${absent} manifest(s) name a run that is absent`);
  return problems;
}

/** A run the inventory names but no binding can be built for. */
function unreadableRow(manifest: PreparationManifestV1, keyStatus: string): PreparationRunRowV1 {
  return {
    workspaceId: manifest.workspaceId, preparationId: manifest.preparationId,
    runId: manifest.runId, state: null, detail: `preparation key is ${keyStatus}`,
  };
}

/**
 * The answer when the key cannot be read.
 *
 * NO EARLY RETURN TO ZERO ROWS. Collapsing every known run here stated a
 * falsehood — "no preparation runs" with a run on disk — and violated this
 * file's own could-not-see rule. An ABSENT key is the healthy pre-staging state,
 * so it is only worth reporting when the store has manifests it therefore
 * cannot read; reporting it on a pristine directory trains readers to ignore
 * the problem lines that matter.
 *
 * RUN ACCOUNTING RUNS HERE TOO. This branch returned before the cross-check, so
 * a store missing BOTH its preparation directory and its key answered
 * `{"runs": [], "problems": []}` with run bytes on disk — the exact silent
 * empty answer the cross-check exists to prevent, surviving in the one branch
 * that skipped it.
 */
function keylessListing(
  inventory: Awaited<ReturnType<typeof scanPreparationInventory>>,
  manifests: readonly PreparationManifestV1[],
  keyStatus: string, problems: readonly string[], readiness: readonly string[],
): ListResultV1 {
  const rows = manifests.map((manifest) => unreadableRow(manifest, keyStatus));
  const keyProblem = manifests.length === 0 && keyStatus === "absent"
    ? []
    : [`preparation key is ${keyStatus}`];
  // ACCOUNTED OVER THE FULL ROW SET, capped only afterwards — see the note in
  // `listPreparationsOperation`. The key line joins the DERIVED family: it is
  // the reason every row here is unreadable, so a plantable problem set must
  // not be able to evict it.
  return bounded(rows, [...readiness, ...keyProblem, ...unlistedRunProblems(inventory, rows)], problems);
}

/**
 * The readiness line, when the project itself is not something to list runs from.
 *
 * IT IS A PROBLEM, NOT A REFUSAL, because `list` has no refusal arm and should
 * not grow one: every other could-not-see in this file is carried in the answer
 * rather than collapsed away, and the project-level one belongs in the same
 * place. It joins the DERIVED family, which the cap reserves room for — a
 * plantable manifest set must not be able to evict the line saying the answer
 * came from somewhere that is not a project.
 *
 * WITHOUT IT, A NON-PROJECT DIRECTORY LISTED CLEAN. The scan finds no inventory
 * anywhere, every cross-check compares zero against zero, and the answer was
 * `{"runs": [], "problems": []}` — indistinguishable from a healthy project with
 * no runs. An operator one directory up from their project was told their runs
 * did not exist.
 */
function readinessProblems(readiness: ReadReadinessV1): readonly string[] {
  return readiness.status === "ready" ? [] : [`project-readiness: ${readiness.detail}`];
}

/** Enumerate every preparation run this project can account for. */
export async function listPreparationsOperation(root: string): Promise<ListResultV1> {
  // FIRST, so the answer can never claim an empty store for a directory that is
  // not one — or for one this process could not read.
  const readiness = await resolvePreparationReadReadiness(root);
  const inventory = await scanPreparationInventory(root);
  // ORDERED BEFORE ANYTHING IS CAPPED. A cap over an unordered walk answers
  // with a different hundred runs each time it is called.
  const manifests = [...inventory.manifests].sort(comparePreparationListing);
  // The PATH is carried, where the scan localized the problem. Without it a
  // reader is told "leaf-unavailable" with no way to learn WHICH preparation
  // vanished from the listing — and a shortened `manifests` array still reads
  // as a complete answer. SORTED for the same reason the runs are: the scan's
  // own enumeration order is a directory order, and the cap has to be stable.
  const problems = inventory.problems.map((problem) =>
    problem.path === undefined
      ? `${problem.dimension}: ${problem.detail}`
      : `${problem.dimension}: ${problem.detail} (${problem.path})`).sort();
  const key = await readPreparationKey(root);
  // `readPreparationRun` reads the key itself and returns the distinct typed
  // codes `integrity-key-missing` / `integrity-key-unreadable`, so letting the
  // rows leg run produces the right per-run taxonomy for free.
  if (key.status !== "ok") {
    return keylessListing(inventory, manifests, key.status, problems, readinessProblems(readiness));
  }
  const rows = await readRows(root, manifests, key.keyEpochId);
  // THE CROSS-CHECK RUNS OVER THE FULL ROW SET, BEFORE THE CAP. Accounting for
  // capped rows would report `the scan saw 150 run leaves but only 100 could be
  // listed` on every healthy store with more than a hundred runs — turning the
  // one control that catches a silently-empty answer into noise operators learn
  // to ignore. The cap is a response bound; it is not a failure to account.
  //
  // And it is passed as the DERIVED family, which the cap reserves room for
  // rather than slices — see `bounded`.
  return bounded(rows, [...readinessProblems(readiness), ...unlistedRunProblems(inventory, rows)], problems);
}

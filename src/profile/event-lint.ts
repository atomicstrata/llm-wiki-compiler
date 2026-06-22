/**
 * @file src/profile/event-lint.ts
 * @description Event-store lint findings, making the append-only HASH-CHAINED
 * event store (`wiki/graph/events.jsonl`, CLP 4b) VISIBLE through the
 * profile-aware lint runner — additively, alongside the relation findings.
 *
 * The audit log is tamper-EVIDENT, so the lint must be tamper-DETECTING: a
 * broken/forked/reordered/interior-deleted chain, or a head-anchor mismatch
 * (a truncated or wholesale-rewritten log), MUST surface — never silently pass.
 *
 * Four concerns, all fail-open or fail-closed (lint NEVER crashes):
 *   - `event-chain-broken` (error): {@link readEvents} surfaced a chain-link
 *     break OR a head-anchor mismatch as a `problem`. The chain no longer
 *     verifies, so the log is tampered — a fail-closed ERROR.
 *   - `event-store-torn` (warning): the reader tolerated and REPORTED a torn
 *     trailing line (an incomplete final append, e.g. a crash mid-emit).
 *     Surfaced so the half-written record is visible; events before it count.
 *   - `event-store-corrupt` / `event-store-too-new` / `event-store-symlink`
 *     (error): the reader FAILED CLOSED (interior corruption / an unknown future
 *     schema version / a symlinked-or-non-regular store-file leaf). Caught here
 *     so lint reports the failure instead of throwing.
 *
 * A DEFAULT or event-LESS project (no `events.jsonl`) reads an EMPTY store with
 * no problems, so this yields no findings and lint output stays byte-identical.
 */

import { readEvents } from "../events/store-read.js";
import {
  EventStoreCorruptError,
  EventStoreTooNewError,
  EventStoreSymlinkError,
  EventStoreFullError,
} from "../events/types.js";
import { GraphDirConfinementError } from "../utils/jsonl-store.js";
import { PrivateDirConfinementError } from "../utils/private-dir.js";
import type { LintResult } from "../linter/types.js";

/** Rule id for a broken/forked/reordered chain or a head-anchor (truncation) mismatch. */
const EVENT_CHAIN_BROKEN_RULE = "event-chain-broken";
/** Rule id for a tolerated torn trailing line reported by the store reader. */
const EVENT_STORE_TORN_RULE = "event-store-torn";
/** Rule id for a fail-closed interior-corruption read. */
const EVENT_STORE_CORRUPT_RULE = "event-store-corrupt";
/** Rule id for a fail-closed unknown-future-schema-version read. */
const EVENT_STORE_TOO_NEW_RULE = "event-store-too-new";
/** Rule id for a fail-closed symlinked/non-regular store-file leaf read. */
const EVENT_STORE_SYMLINK_RULE = "event-store-symlink";
/** Rule id for a fail-closed symlinked/escaping `wiki/graph` DIR (confinement). */
const EVENT_STORE_GRAPH_DIR_RULE = "event-store-graph-dir";
/** Rule id for a fail-closed symlinked/escaping `.llmwiki` private dir (confinement). */
const EVENT_STORE_PRIVATE_DIR_RULE = "event-store-private-dir";
/** Rule id for a fail-closed append-refused-because-store-is-full condition. */
const EVENT_STORE_FULL_RULE = "event-store-full";

/** The lint `file` label for store-level event findings. */
const EVENT_STORE_FILE = "wiki/graph/events.jsonl";

/**
 * Distinguish a tolerated torn-trailing problem from a fail-closed chain/anchor
 * problem. {@link readEvents} tags a torn line with this exact prefix (see
 * `parseRecords`); every other surfaced problem (chain link / head anchor) is a
 * tamper signal that must escalate to a fail-closed `event-chain-broken` error.
 */
const TORN_PROBLEM_PREFIX = "tolerated torn trailing line";

/** Build the store-level finding a fail-closed read maps to, by error type. */
function readErrorFinding(error: unknown): LintResult | null {
  if (error instanceof EventStoreTooNewError) {
    return { rule: EVENT_STORE_TOO_NEW_RULE, severity: "error", file: EVENT_STORE_FILE, message: error.message };
  }
  if (error instanceof EventStoreCorruptError) {
    return { rule: EVENT_STORE_CORRUPT_RULE, severity: "error", file: EVENT_STORE_FILE, message: error.message };
  }
  if (error instanceof EventStoreSymlinkError) {
    return { rule: EVENT_STORE_SYMLINK_RULE, severity: "error", file: EVENT_STORE_FILE, message: error.message };
  }
  if (error instanceof EventStoreFullError) {
    return { rule: EVENT_STORE_FULL_RULE, severity: "error", file: EVENT_STORE_FILE, message: error.message };
  }
  if (error instanceof GraphDirConfinementError) {
    return { rule: EVENT_STORE_GRAPH_DIR_RULE, severity: "error", file: EVENT_STORE_FILE, message: error.message };
  }
  if (error instanceof PrivateDirConfinementError) {
    return { rule: EVENT_STORE_PRIVATE_DIR_RULE, severity: "error", file: EVENT_STORE_FILE, message: error.message };
  }
  return null;
}

/** Map one surfaced reader problem to a torn WARNING or a chain-broken ERROR finding. */
function problemToFinding(problem: string): LintResult {
  if (problem.startsWith(TORN_PROBLEM_PREFIX)) {
    return { rule: EVENT_STORE_TORN_RULE, severity: "warning", file: EVENT_STORE_FILE, message: problem };
  }
  return { rule: EVENT_CHAIN_BROKEN_RULE, severity: "error", file: EVENT_STORE_FILE, message: problem };
}

/**
 * Surface the event store's integrity issues as additive lint findings.
 *
 * Reads the store fail-closed (a corrupt / too-new / symlinked store becomes a
 * single store-level ERROR finding rather than a thrown error), then maps every
 * tolerated/surfaced reader problem to a finding: a torn trailing line to an
 * `event-store-torn` WARNING, and any chain-link break or head-anchor mismatch
 * (tamper evidence: edit/reorder/delete/truncate) to an `event-chain-broken`
 * ERROR. A healthy or event-LESS store yields no findings.
 *
 * @param root - Absolute project root directory.
 * @returns All event-store findings (possibly empty). Never throws a store error.
 */
export async function checkEventChain(root: string): Promise<LintResult[]> {
  let read;
  try {
    read = await readEvents(root);
  } catch (error) {
    const finding = readErrorFinding(error);
    if (finding) return [finding];
    throw error; // a non-store error (e.g. a confinement escape) is not ours to swallow
  }
  return read.problems.map(problemToFinding);
}

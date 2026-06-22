/**
 * Shared non-default-profile summary block (profileId, digest, per-type entity
 * counts, problems).
 *
 * This is the single source of truth for the additive `profile` block that the
 * `status` collector and the viewer snapshot both surface. Centralizing it
 * keeps the two surfaces byte-identical to each other and prevents the gate
 * logic (built-in-default detection, count seeding, problem mapping) from
 * drifting between them.
 *
 * For the built-in default profile this returns `undefined` so each caller
 * omits the `profile` key entirely and its default envelope is unchanged. The
 * built-in is identified by `loadedFrom === null` (never by `profileId`), with
 * a digest cross-check as defense-in-depth against a future loader change.
 */

import { loadProfile } from "./load.js";
import { collectEntityPages, collectEntitySummary } from "./collect.js";
import type { EntityProblem } from "./collect.js";
import { DEFAULT_PROFILE } from "./default.js";
import { profileDigest } from "./digest.js";
import { toEntityProblemView } from "./types.js";
import type { EntityPage, EntityProblemView, LoadedProfile } from "./types.js";
import { safeRealpath } from "../utils/path-confine.js";
import { readRelations } from "../relations/store-read.js";
import { validateRelationAgainstProfile } from "../relations/relation-contract.js";
import { RelationStoreCorruptError, RelationStoreTooNewError, RelationStoreSymlinkError } from "../relations/types.js";
import { GraphDirConfinementError } from "../utils/jsonl-store.js";
import { PrivateDirConfinementError } from "../utils/private-dir.js";
import type { RelationRef } from "../relations/types.js";
import { readEvents } from "../events/store-read.js";
import { EventStoreCorruptError, EventStoreTooNewError, EventStoreSymlinkError, EventStoreFullError } from "../events/types.js";

/**
 * Load the active profile and return it ONLY when it is a non-default profile;
 * return `undefined` for the built-in default so every additive read surface
 * can omit its `profile` key with one shared gate.
 *
 * The built-in is identified by `loadedFrom === null` (the loader sets null
 * ONLY for the no-file/default path) — never by `profileId === "default"`,
 * which a disk profile can no longer claim but which must not be the gate. The
 * digest comparison is defense-in-depth against a future loader change.
 *
 * @param root - Absolute project root directory.
 * @returns The loaded non-default profile, or `undefined` for the built-in default.
 */
export async function loadNonDefaultProfile(
  root: string,
): Promise<LoadedProfile | undefined> {
  const loaded = await loadProfile(root);
  const isBuiltInDefault =
    loaded.loadedFrom === null && loaded.digest === profileDigest(DEFAULT_PROFILE);
  return isBuiltInDefault ? undefined : loaded;
}

/**
 * The maximum number of structured `problems` the count-only status/viewer
 * summary surfaces inline. A profile with thousands of invalid pages is never
 * dumped wholesale into a status/viewer envelope; `problemTotal` always reports
 * the full count so the cap is visible. Export keeps the COMPLETE list (it is a
 * full snapshot), and `listPages` paginates instead of capping — only this
 * count-only summary applies the cap.
 */
export const PROFILE_PROBLEM_CAP = 100;

/** The additive profile summary shared by the status and viewer surfaces. */
export interface ProfileSummaryBlock {
  profileId: string;
  digest: string;
  entityCounts: Record<string, number>;
  /**
   * Structured collector problems, CAPPED at {@link PROFILE_PROBLEM_CAP}.
   * Present ONLY when non-empty, so a non-default project with a bad directory
   * or page is never reported as silently healthy. Each problem's `path` is
   * project-relative (never absolute) and absent for directory-level problems.
   */
  problems?: EntityProblemView[];
  /**
   * Full count of collector problems (may exceed `problems.length` when capped).
   * Present ONLY when there is at least one problem.
   */
  problemTotal?: number;
  /**
   * Live relation counts per relation type, present ONLY for a non-default
   * profile whose `wiki/graph` store holds at least one relation. OMITTED for
   * the built-in default and for any relation-LESS profile, so the default and
   * relation-less status/viewer envelopes stay byte-identical. A corrupt /
   * too-new / symlinked-leaf store does NOT populate this — it surfaces through
   * `problems` instead (fail-closed, never a silent zero).
   */
  relationCounts?: Record<string, number>;
  /** Total live relation count; present alongside (and equal to the sum of) `relationCounts`. */
  relationTotal?: number;
  /**
   * Total events in the append-only hash-chained audit log, present ONLY for a
   * non-default profile whose `wiki/graph` store holds at least one event.
   * OMITTED for the built-in default and for any event-LESS profile, so the
   * default and event-less status/viewer envelopes stay byte-identical. A
   * corrupt / too-new / symlinked-leaf store OR a broken/truncated chain does
   * NOT populate this — it surfaces through `problems` instead (fail-closed,
   * never a silent count reported as healthy).
   */
  eventCount?: number;
}

/**
 * Collect a loaded non-default profile's entity pages alongside its STRUCTURED
 * problems (already mapped to public, path-safe {@link EntityProblemView}s) — the
 * shared read-side step every additive profile block performs before shaping
 * (windowing, capping, or passing through) its own problem envelope.
 *
 * @param root - Absolute project root directory.
 * @param loaded - A non-default profile (from {@link loadNonDefaultProfile}).
 * @returns The collected entity pages and the structured problem views.
 */
export async function collectEntityPagesWithMessages(
  root: string,
  loaded: LoadedProfile,
): Promise<{ pages: EntityPage[]; problems: EntityProblemView[] }> {
  const { pages, problems } = await collectEntityPages(root, loaded.profile);
  return { pages, problems: await toProblemViews(problems, root) };
}

/**
 * Map structured collector problems to public, path-safe problem views,
 * relativizing each `filePath` against the CANONICAL root. The collector
 * resolves every `filePath` through `safeRealpath`, so a non-canonical input
 * `root` (e.g. a `/var` path whose real form is `/private/var`) would otherwise
 * yield a misleading `../…` traversal instead of a clean project-relative path.
 */
async function toProblemViews(
  problems: EntityProblem[],
  root: string,
): Promise<EntityProblemView[]> {
  const canonicalRoot = (await safeRealpath(root)) ?? root;
  return problems.map((problem) => toEntityProblemView(problem, canonicalRoot));
}

/**
 * The relation-store contribution to the summary block: per-type live counts
 * (present only when non-empty) and at most one fail-closed read problem.
 */
interface RelationSummary {
  relationCounts?: Record<string, number>;
  relationTotal?: number;
  problem?: EntityProblemView;
}

/** Map a fail-closed relation-store read error to a `relation-store` problem view. */
function relationReadProblem(error: unknown): EntityProblemView {
  if (
    error instanceof RelationStoreTooNewError ||
    error instanceof RelationStoreCorruptError ||
    error instanceof RelationStoreSymlinkError ||
    error instanceof GraphDirConfinementError // a symlinked/escaping wiki/graph DIR (FIX F5)
  ) {
    return { kind: "relation-store", message: error.message };
  }
  throw error; // a non-store error (e.g. a confinement escape) is not ours to swallow
}

/** A `relation-store` problem reporting the count of profile-invalid stored relations. */
function relationProfileInvalidProblem(count: number): EntityProblemView {
  return {
    kind: "relation-store",
    message: `${count} stored relation(s) are no longer valid against the current profile (retained, not counted as live)`,
  };
}

/**
 * Tally per-type counts over only the relations STILL VALID against the current
 * profile; relations whose type/endpoints/attributes the profile has outgrown are
 * excluded from the live counts and surfaced as a single `relation-store` problem.
 */
function tallyValidRelations(relations: RelationRef[], loaded: LoadedProfile): RelationSummary {
  const counts: Record<string, number> = {};
  let valid = 0;
  let invalid = 0;
  for (const rel of relations) {
    if (validateRelationAgainstProfile(rel, loaded.profile).length > 0) { invalid += 1; continue; }
    counts[rel.type] = (counts[rel.type] ?? 0) + 1;
    valid += 1;
  }
  const problem = invalid > 0 ? relationProfileInvalidProblem(invalid) : undefined;
  if (valid === 0) return { ...(problem ? { problem } : {}) };
  return { relationCounts: counts, relationTotal: valid, ...(problem ? { problem } : {}) };
}

/**
 * Read the live relation store for a non-default profile and reduce it to the
 * additive summary contribution: per-type counts of relations STILL VALID against
 * the current profile (OMITTED when none are, so a relation-less or fully-stale
 * profile gains no count fields), and a single `relation-store` problem on a
 * fail-closed read OR when stored relations are no longer profile-valid (the
 * invalid ones are retained on disk, never counted as live).
 *
 * @param root - Absolute project root directory.
 * @param loaded - The loaded non-default profile (its `relations` block gates).
 * @returns The valid relation counts/total and/or a problem.
 */
async function summarizeRelations(root: string, loaded: LoadedProfile): Promise<RelationSummary> {
  // The store is read even when the profile declares NO `relations` block: a
  // relation-less project has no `wiki/graph` store, so the read returns empty
  // (→ `{}`, byte-identical), but a project whose `relations` block was REMOVED
  // while records remain on disk must still surface them as profile-invalid
  // rather than silently vanishing.
  let relations;
  try {
    ({ relations } = await readRelations(root));
  } catch (error) {
    return { problem: relationReadProblem(error) };
  }
  if (relations.length === 0) return {};
  return tallyValidRelations(relations, loaded);
}

/**
 * The event-store contribution to the summary block: the total event count
 * (present only for an intact, non-empty log) and at most one fail-closed read
 * or broken-chain problem. The two are mutually exclusive — a tamper signal
 * suppresses the count so a broken store is never reported as silently healthy.
 */
interface EventSummary {
  eventCount?: number;
  problem?: EntityProblemView;
}

/** Map a fail-closed event-store read error to an `event-store` problem view. */
function eventReadProblem(error: unknown): EntityProblemView {
  if (
    error instanceof EventStoreTooNewError ||
    error instanceof EventStoreCorruptError ||
    error instanceof EventStoreSymlinkError ||
    error instanceof EventStoreFullError ||
    error instanceof GraphDirConfinementError || // a symlinked/escaping wiki/graph DIR (FIX F5)
    error instanceof PrivateDirConfinementError // a symlinked/escaping .llmwiki dir (B5)
  ) {
    return { kind: "event-store", message: error.message };
  }
  throw error; // a non-store error (e.g. a confinement escape) is not ours to swallow
}

/** The torn-trailing-line prefix {@link readEvents} tags; any OTHER problem is a chain/anchor tamper signal. */
const TORN_EVENT_PREFIX = "tolerated torn trailing line";

/**
 * Reduce a successful (non-throwing) {@link readEvents} result to the summary
 * contribution. A chain-link break or head-anchor (truncation) mismatch is a
 * tamper signal: surface it as an `event-store` problem and SUPPRESS the count
 * (never report a broken chain as a healthy total). A torn trailing line is
 * tolerated — the valid events before it are still counted.
 */
function summarizeReadEvents(read: { events: { length: number }; problems: string[] }): EventSummary {
  const tamper = read.problems.find((p) => !p.startsWith(TORN_EVENT_PREFIX));
  if (tamper !== undefined) return { problem: { kind: "event-store", message: tamper } };
  if (read.events.length === 0) return {};
  return { eventCount: read.events.length };
}

/**
 * Read the hash-chained event store for a non-default profile and reduce it to
 * the additive summary contribution: the total event count (OMITTED for an
 * event-LESS store, so an event-less project's envelope stays byte-identical),
 * and a single `event-store` problem on a fail-closed read (corrupt / too-new /
 * symlink) OR a broken/truncated chain — in which case the count is suppressed
 * rather than reported as a healthy total.
 *
 * @param root - Absolute project root directory.
 * @returns The event count and/or a problem.
 */
async function summarizeEvents(root: string): Promise<EventSummary> {
  let read;
  try {
    read = await readEvents(root);
  } catch (error) {
    return { problem: eventReadProblem(error) };
  }
  return summarizeReadEvents(read);
}

/**
 * Resolve the active profile and, for a NON-DEFAULT profile only, build the
 * shared summary block (profileId, digest, per-type entity counts, problems).
 *
 * Uses the COUNT-ONLY {@link collectEntitySummary} so the status/viewer surfaces
 * never build or retain content `EntityPage`s (with bodies) just to tally — the
 * counts and structured problems are identical to the content path, which shares
 * the same per-scan validation. Problems are CAPPED at {@link PROFILE_PROBLEM_CAP}
 * (with `problemTotal` reporting the full count) so a hugely invalid profile is
 * never dumped wholesale into a status/viewer envelope.
 *
 * @param root - Absolute project root directory.
 * @returns The summary block for a non-default profile, or `undefined` for the
 *   built-in default so the caller omits the `profile` key entirely.
 */
/** Shape the combined problem views into the capped `problems`/`problemTotal` pair (omitted when empty). */
function problemEnvelope(views: EntityProblemView[]): Pick<ProfileSummaryBlock, "problems" | "problemTotal"> {
  if (views.length === 0) return {};
  return { problems: views.slice(0, PROFILE_PROBLEM_CAP), problemTotal: views.length };
}

export async function collectProfileSummary(
  root: string,
): Promise<ProfileSummaryBlock | undefined> {
  const loaded = await loadNonDefaultProfile(root);
  if (loaded === undefined) return undefined;
  const { counts, problems } = await collectEntitySummary(root, loaded.profile);
  const { relationCounts, relationTotal, problem } = await summarizeRelations(root, loaded);
  const { eventCount, problem: eventProblem } = await summarizeEvents(root);
  const storeProblems = [...(problem ? [problem] : []), ...(eventProblem ? [eventProblem] : [])];
  const views = [...(await toProblemViews(problems, root)), ...storeProblems];
  return {
    profileId: loaded.profile.profileId,
    digest: loaded.digest,
    entityCounts: counts,
    ...problemEnvelope(views),
    ...(relationCounts ? { relationCounts, relationTotal } : {}),
    ...(eventCount !== undefined ? { eventCount } : {}),
  };
}

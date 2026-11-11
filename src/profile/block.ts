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
 *
 * ONE BODY: {@link collectProfileSummary} runs {@link collectProfileSummaryFrom}
 * over local-disk {@link ProfileSummarySources}. The default gate, the order of
 * the reads, which failure becomes which problem and which rejects, the cap and
 * every "omit when empty" rule are decided in this file; the sources only look.
 * Artifact health is read through sources too: it scans, reads the relation
 * store and asks for the real path through the same objects. What a pinned
 * ref resolves to is worked out by the resolver's one body over the artifact
 * store's leaf reads, {@link ProfileSummarySources.artifacts}. Whether a run
 * vouches for it is worked out by the verifier's one body over the
 * preparation store's leaf reads, {@link ProfileSummarySources.provenance}.
 * The lifecycle read under them stays ROOT-BOUND DISK AUTHORITY on disk: a
 * named deferment, not made neutral.
 */

import { diskEffectiveProfileSources, loadProfile, loadProfileFrom, type EffectiveProfileSources } from "./load.js";
import { collectEntityPagesFrom, collectEntitySummaryFrom } from "./collect.js";
import type { EntityProblem } from "./collect.js";
import { DEFAULT_PROFILE } from "./default.js";
import { profileDigest } from "./digest.js";
import { toEntityProblemView } from "./types.js";
import { collectStandingRelationProblemsFrom } from "./relation-standing.js";
import { diskEntityPageReads, type EntityPageReads } from "./lifecycle-read.js";
import {
  artifactProblemViewsFrom, collectArtifactRefPageSourcesFrom, diskArtifactHealthSources,
} from "./artifact-lint.js";
import type { ArtifactStoreReads } from "../artifacts/resolve.js";
import type { PreparationStoreLeafReads } from "../preparations/store-leaf-reads.js";
import type { EntityPage, EntityProblemView, EntityTypeDef, LoadedProfile } from "./types.js";
import { scanEntityDirFrom } from "../wiki/collect.js";
import { diskLocalEntityScans } from "../storage/disk-local-reads.js";
import type { LegacyLocalEntityScans } from "../storage/legacy-local-reads.js";
import { safeRealpath } from "../utils/path-confine.js";
import { readRelationsFrom } from "../relations/store-read.js";
import { validateRelationAgainstProfile } from "../relations/relation-contract.js";
import { RelationStoreCorruptError, RelationStoreTooNewError, RelationStoreSymlinkError } from "../relations/types.js";
import { diskGraphStoreReads, GraphDirConfinementError, type GraphStoreReads } from "../utils/jsonl-store.js";
import { PrivateDirConfinementError } from "../utils/private-dir.js";
import type { RelationRef } from "../relations/types.js";
import { diskEventReadSources, readEventsFrom, type EventReadSources } from "../events/store-read.js";
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
 * Effective-profile loading routes through the active-product binding via the
 * universal {@link loadProfile}: with no binding this is byte-identical to the
 * legacy path, and a product-mode binding yields the product's knowledge profile
 * (always non-default, since its `loadedFrom` is a package member path, so it is
 * never mistaken for the built-in default).
 *
 * @param root - Absolute project root directory.
 * @returns The loaded non-default profile, or `undefined` for the built-in default.
 */
export async function loadNonDefaultProfile(
  root: string,
): Promise<LoadedProfile | undefined> {
  // Through `loadProfile`, so a lock-held section shares its one load (see profile/load.ts).
  return nonDefault(await loadProfile(root));
}

/** {@link loadNonDefaultProfile} over the profile sources: one load, then the one gate. */
export async function loadNonDefaultProfileFrom(
  sources: EffectiveProfileSources,
): Promise<LoadedProfile | undefined> {
  return nonDefault(await loadProfileFrom(sources));
}

/** THE ONE GATE: a loaded profile, or `undefined` when it is the built-in default. */
function nonDefault(loaded: LoadedProfile): LoadedProfile | undefined {
  const isBuiltInDefault =
    loaded.loadedFrom === null && loaded.digest === profileDigest(DEFAULT_PROFILE);
  return isBuiltInDefault ? undefined : loaded;
}

/** A profile pre-resolved by a caller: a {@link LoadedProfile}, or `null` for the built-in default. */
export type PreloadedProfile = LoadedProfile | null;

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
  /**
   * Per-entity-type tally of the CURRENT lifecycle-field value across that
   * type's enrolled pages — e.g. `{ ideas: { proposed: 1, testing: 2 } }`.
   * Computed ONLY for entity types that declare a `lifecycle`, from the bounded
   * frontmatter-only scan (no page bodies are read). This is the at-a-glance
   * surface that makes a lifecycle TRANSITION visible to `status`/`wiki_status`:
   * a field-flip changes the per-state counts here, not just `eventCount`.
   *
   * OMITTED entirely when no entity type declares a lifecycle OR no lifecycle
   * page carries a value, so the built-in default and any lifecycle-less profile
   * produce byte-identical status/viewer envelopes. A type with a lifecycle but
   * no enrolled pages contributes no key.
   */
  lifecycleStates?: Record<string, Record<string, number>>;
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
  return collectEntityPagesWithMessagesFrom(diskEntityPagesWithMessagesSources(root), loaded);
}

/**
 * What {@link collectEntityPagesWithMessagesFrom} reads through, and the one
 * identity value it uses. Naming these selects no backend and rules on no
 * mechanism.
 */
export interface EntityPagesWithMessagesSources {
  /** The entity directories: every declared type's directory is scanned WITH bodies, in declaration order. */
  scans: LegacyLocalEntityScans;
  /** The project root's real path, or `null` when it cannot be resolved. Asked ONCE, AFTER the collection, and ALWAYS, with no problems too. */
  realRoot(): Promise<string | null>;
  /**
   * The root as the caller gave it. NOT READ THROUGH: it is a label that
   * problem paths are made relative to when `realRoot` answers `null`, and it
   * authorizes no read.
   */
  root: string;
}

/** LOCAL DISK. The sources for the project at `root`, private to this module. Building them does no I/O. */
function diskEntityPagesWithMessagesSources(root: string): EntityPagesWithMessagesSources {
  return { scans: diskLocalEntityScans(root), realRoot: () => safeRealpath(root), root };
}

/**
 * {@link collectEntityPagesWithMessages} over its sources: THE ONE BODY. The
 * collection first (the default profile throws there, before any scan and
 * before the real-path look); then the problems are mapped to views. `loaded`
 * is used as given: nothing is reloaded and nothing is remembered.
 *
 * Each problem's `filePath` is made relative to the CANONICAL root. The
 * collector's file paths are resolved paths, so a non-canonical root as given
 * (e.g. a `/var` path whose real form is `/private/var`) would otherwise yield
 * a misleading `../…` traversal instead of a clean project-relative path.
 */
export async function collectEntityPagesWithMessagesFrom(
  sources: EntityPagesWithMessagesSources,
  loaded: LoadedProfile,
): Promise<{ pages: EntityPage[]; problems: EntityProblemView[] }> {
  const { pages, problems } = await collectEntityPagesFrom(sources.scans, loaded.profile);
  return { pages, problems: await toProblemViewsOver(problems, () => sources.realRoot(), sources.root) };
}

/**
 * Structured collector problems as public, path-safe views, over a real-path
 * look: THE ONE BODY. The look is ALWAYS made, for an empty list too; when it
 * answers `null` the root as given is used.
 */
async function toProblemViewsOver(
  problems: EntityProblem[],
  realRoot: () => Promise<string | null>,
  root: string,
): Promise<EntityProblemView[]> {
  const canonicalRoot = (await realRoot()) ?? root;
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

/**
 * Map a fail-closed relation-store read error (corrupt / too-new / symlinked-leaf
 * / symlinked-or-escaping `wiki/graph` dir) to a `relation-store` problem view.
 *
 * This is the SINGLE mapper for the store-UNAVAILABLE case, shared by every
 * surface that must fail closed VISIBLY (status, viewer, AND the JSON export) so
 * a broken store is never reported as a silent "no relations". A store-unavailable
 * problem is distinguishable from a {@link relationProfileInvalidProblem} (the
 * store is healthy, some stored relations are just stale) via
 * {@link isRelationStoreUnavailableProblem}.
 *
 * @param error - The caught relation-store read error.
 * @returns The `relation-store` problem view, or rethrows a non-store error.
 */
export function relationReadProblem(error: unknown): EntityProblemView {
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

/**
 * The trailing clause unique to the profile-invalid relation problem. It is the
 * SOLE `relation-store` message produced WITHOUT a fail-closed read, so its
 * suffix is the discriminator {@link isRelationStoreUnavailableProblem} uses to
 * exclude the healthy-store-stale-data case from the store-UNAVAILABLE case.
 */
const RELATION_PROFILE_INVALID_SUFFIX = "(retained, not counted as live)";

/** Build the stable message for the profile-invalid (NOT store-unavailable) relation problem. */
function relationProfileInvalidMessage(count: number): string {
  return `${count} stored relation(s) are no longer valid against the current profile ${RELATION_PROFILE_INVALID_SUFFIX}`;
}

/** A `relation-store` problem reporting the count of profile-invalid stored relations. */
function relationProfileInvalidProblem(count: number): EntityProblemView {
  return { kind: "relation-store", message: relationProfileInvalidMessage(count) };
}

/**
 * True when a problem reports the relation store is UNAVAILABLE (corrupt /
 * too-new / symlink / confinement) rather than merely holding stale,
 * profile-invalid relations on an otherwise-healthy store. Both share
 * `kind: "relation-store"`, so this narrows to the fail-closed read case — the
 * one agent-facing surfaces (context) must warn about. The profile-invalid case
 * is the SOLE `relation-store` message produced WITHOUT a read failure, so it is
 * the only one excluded.
 *
 * @param problem - A problem view from `snapshot.profile.problems`.
 * @returns Whether the problem signals an unavailable relation store.
 */
export function isRelationStoreUnavailableProblem(problem: EntityProblemView): boolean {
  if (problem.kind !== "relation-store") return false;
  return !problem.message.endsWith(RELATION_PROFILE_INVALID_SUFFIX);
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
 * @param graph - The graph-store read the relation store is asked through.
 * @param loaded - The loaded non-default profile (its `relations` block gates).
 * @returns The valid relation counts/total and/or a problem.
 */
async function summarizeRelations(graph: GraphStoreReads, loaded: LoadedProfile): Promise<RelationSummary> {
  // The store is read even when the profile declares NO `relations` block: a
  // relation-less project has no `wiki/graph` store, so the read returns empty
  // (→ `{}`, byte-identical), but a project whose `relations` block was REMOVED
  // while records remain on disk must still surface them as profile-invalid
  // rather than silently vanishing.
  let relations;
  try {
    ({ relations } = await readRelationsFrom(graph));
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
    // DEFENSIVE: read maps an oversize store to EventStoreCorruptError, so read
    // never throws Full (Full is write-side only); kept for the defensive mapping.
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
 * @param events - The event-read sources (the store, then its head anchor).
 * @returns The event count and/or a problem.
 */
async function summarizeEvents(events: EventReadSources): Promise<EventSummary> {
  let read;
  try {
    read = await readEventsFrom(events);
  } catch (error) {
    return { problem: eventReadProblem(error) };
  }
  return summarizeReadEvents(read);
}

/**
 * Tally one lifecycle-declaring entity type's CURRENT lifecycle-field value
 * across its pages via the bounded frontmatter-only scan
 * (`scanEntityDir(..., { includeBody: false })`) — page bodies are never read.
 * Only string values are counted (a declared lifecycle state is always a
 * string); a page that omits the field or carries a non-string is skipped.
 *
 * @returns The `{ state: count }` map, or `undefined` when no page carries a
 *   string value (so the caller omits this type's key).
 */
async function tallyLifecycleStates(
  source: LegacyLocalEntityScans,
  def: EntityTypeDef,
  field: string,
): Promise<Record<string, number> | undefined> {
  const { scans } = await scanEntityDirFrom(source, def.directory, { includeBody: false });
  const counts: Record<string, number> = {};
  for (const scan of scans) {
    const value = scan.frontmatter[field];
    if (typeof value === "string") counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

/**
 * Build the per-type lifecycle-state tally for every entity type that declares a
 * `lifecycle`, reading each page's lifecycle field through the bounded
 * frontmatter-only scan (no bodies). Returns `undefined` when no lifecycle type
 * has any enrolled page (so the `lifecycleStates` key is OMITTED — the
 * default and lifecycle-less envelopes stay byte-identical).
 *
 * @param source - The entity-scan binding the lifecycle directories are scanned through.
 * @param loaded - The loaded non-default profile (its entity `lifecycle` gates).
 * @returns The `{ entityType: { state: count } }` tally, or `undefined`.
 */
async function summarizeLifecycleStates(
  source: LegacyLocalEntityScans,
  loaded: LoadedProfile,
): Promise<Record<string, Record<string, number>> | undefined> {
  const states: Record<string, Record<string, number>> = {};
  for (const [entityType, def] of Object.entries(loaded.profile.entities) as [string, EntityTypeDef][]) {
    if (def.lifecycle === undefined) continue;
    const tally = await tallyLifecycleStates(source, def, def.lifecycle.field);
    if (tally) states[entityType] = tally;
  }
  return Object.keys(states).length > 0 ? states : undefined;
}

/**
 * Whether the profile declares any artifact type: THE ONE GATE on the artifact
 * contribution. An artifact-less profile skips it entirely, so the
 * default/artifact-less status/viewer envelope stays byte-identical.
 */
function declaresArtifacts(loaded: LoadedProfile): boolean {
  const declared = loaded.profile.artifacts;
  return !!declared && Object.keys(declared).length > 0;
}

/**
 * Resolve every hash-pinned artifactRef reachable from a non-default profile's
 * pages/relations and reduce it to the additive summary contribution: the
 * path-safe problem views for any non-`ok` health. It is called ONLY for a
 * profile that declares artifact types ({@link declaresArtifacts}, checked by the
 * summary body), with the profile that body already loaded: no profile is read
 * here. It reads THROUGH THE SUMMARY'S SOURCES and remembers nothing: every
 * declared entity directory again (frontmatter only), the relation store again
 * when the profile declares relations, one resolve per ref occurrence, one
 * provenance check per armed requirement, and its own real-path look when it
 * has results (the summary still asks again, last).
 *
 * @param sources - The summary's sources.
 * @param loaded - The already-loaded non-default profile.
 * @returns The artifact-ref health problems (possibly empty).
 */
async function summarizeArtifacts(sources: ProfileSummarySources, loaded: LoadedProfile): Promise<EntityProblemView[]> {
  const pages = await collectArtifactRefPageSourcesFrom(sources.scans, loaded.profile);
  return artifactProblemViewsFrom(
    { graph: sources.graph, artifacts: sources.artifacts, provenance: sources.provenance }, pages, loaded.profile,
    { realRoot: () => sources.realRoot(), asGiven: sources.profile.activeProduct.root },
  );
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
/**
 * Combine the three problem classes into ONE list, HIGH-SEVERITY FIRST: store-
 * integrity, then standing lifecycle-precondition drift, then the (unbounded, low-
 * severity) per-entity field problems. Ordering is load-bearing because the list
 * is CAPPED ({@link PROFILE_PROBLEM_CAP}) before it reaches the status/viewer/
 * context surfaces (and the context pack derives its standing warnings from the
 * capped array): a project with ≥cap routine entity problems must NOT starve the
 * rare store/standing signals out of the cap and read as silently healthy. Leading
 * with the high-severity classes guarantees they survive the cap.
 */
export function orderProblemViews(
  entity: EntityProblemView[],
  store: EntityProblemView[],
  standing: EntityProblemView[],
): EntityProblemView[] {
  return [...store, ...standing, ...entity];
}

/** Shape the combined problem views into the capped `problems`/`problemTotal` pair (omitted when empty). */
function problemEnvelope(views: EntityProblemView[]): Pick<ProfileSummaryBlock, "problems" | "problemTotal"> {
  if (views.length === 0) return {};
  return { problems: views.slice(0, PROFILE_PROBLEM_CAP), problemTotal: views.length };
}

export async function collectProfileSummary(
  root: string,
): Promise<ProfileSummaryBlock | undefined> {
  // `async` so that a throw while the disk sources are built REJECTS, as this function always did.
  return collectProfileSummaryFrom(diskProfileSummarySources(root));
}

/**
 * Everything {@link collectProfileSummaryFrom} reads. OWNED BY THE SUMMARY: a
 * narrow seam; not `ProjectStore`, not a hosted or access-control contract, and
 * it selects no backend. Every contribution and the real-path look are read
 * through the sources below. `artifacts` is the artifact store's leaf reads;
 * `provenance` is the preparation store's leaf reads, whose `lifecycle`
 * member stays root-bound disk authority on disk.
 * NOTHING TIES THESE OBJECTS TO ONE PROJECT, and nothing makes two reads of one
 * store agree. Production builds them all from one root
 * ({@link diskProfileSummarySources}).
 */
export interface ProfileSummarySources {
  /** The effective profile, loaded FIRST; the built-in default ends the summary. Its `activeProduct.root` is the root as given, used when the real path is unknown. */
  profile: EffectiveProfileSources;
  /** Entity directories, frontmatter only: the counts, the lifecycle tallies, the standing check's gated pages, and every directory once more for artifact health. */
  scans: LegacyLocalEntityScans;
  /** The relation store: the counts, once more for the standing check, and once more for artifact health when relations are declared. */
  graph: GraphStoreReads;
  /** The event store and its head anchor. */
  events: EventReadSources;
  /** One confined page per distinct relation endpoint, for the standing check. */
  pages: EntityPageReads;
  /** The artifact store's leaf reads, for what a pinned ref resolves to. Asked only for a profile that declares artifact types, once per ref occurrence. */
  artifacts: ArtifactStoreReads;
  /** The preparation store's leaf reads, for whether a run vouches for a gated page's pinned artifact. Asked once per armed requirement that has a right-typed ref. */
  provenance: PreparationStoreLeafReads;
  /** The project root's real path, or `null` when it cannot be resolved. Asked LAST and ALWAYS; artifact health asks once before that, only when it has a finding. */
  realRoot(): Promise<string | null>;
}

/**
 * LOCAL DISK. The summary sources for the project at `root`: THE ONE BUILDER,
 * used by {@link collectProfileSummary}, the viewer snapshot, the status
 * composition and the JSON export's profile block (which reads all but the
 * event store). Building
 * them does no I/O and no path work. The relation and event reads share one
 * graph-store read object. The artifact store reads and the preparation
 * store reads come from THE ONE health builder
 * ({@link diskArtifactHealthSources}). In no package index.
 */
export function diskProfileSummarySources(root: string): ProfileSummarySources {
  const graph = diskGraphStoreReads(root);
  const health = diskArtifactHealthSources(root);
  return {
    profile: diskEffectiveProfileSources(root),
    scans: diskLocalEntityScans(root),
    graph,
    events: diskEventReadSources(root, graph),
    pages: diskEntityPageReads(root),
    artifacts: health.artifacts,
    provenance: health.provenance,
    realRoot: () => safeRealpath(root),
  };
}

/**
 * {@link collectProfileSummary} over {@link ProfileSummarySources}: THE ONE BODY.
 * One step after another, never together: the profile; counts; relations;
 * events; lifecycle states; the standing check; artifact health (only when
 * artifact types are declared); the real-path look.
 */
export async function collectProfileSummaryFrom(
  sources: ProfileSummarySources,
): Promise<ProfileSummaryBlock | undefined> {
  const loaded = await loadNonDefaultProfileFrom(sources.profile);
  if (loaded === undefined) return undefined;
  const { counts, problems } = await collectEntitySummaryFrom(sources.scans, loaded.profile);
  const { relationCounts, relationTotal, problem } = await summarizeRelations(sources.graph, loaded);
  const { eventCount, problem: eventProblem } = await summarizeEvents(sources.events);
  const lifecycleStates = await summarizeLifecycleStates(sources.scans, loaded);
  // Re-evaluate every page CURRENTLY in a gated lifecycle state against the live
  // relation graph (READ-ONLY, LOCK-FREE, one relation read): a precondition met at
  // write time can drift as relations are superseded/compacted/dangling or the
  // profile changes. A non-gated/default profile reads nothing and adds none.
  const standingProblems = await collectStandingRelationProblemsFrom(
    { scans: sources.scans, graph: sources.graph, pages: sources.pages }, loaded.profile);
  const artifactProblems = declaresArtifacts(loaded) ? await summarizeArtifacts(sources, loaded) : [];
  const storeProblems = [...(problem ? [problem] : []), ...(eventProblem ? [eventProblem] : []), ...artifactProblems];
  const entityViews = await toProblemViewsOver(problems, () => sources.realRoot(), sources.profile.activeProduct.root);
  const views = orderProblemViews(entityViews, storeProblems, standingProblems);
  return {
    profileId: loaded.profile.profileId,
    digest: loaded.digest,
    entityCounts: counts,
    ...problemEnvelope(views),
    ...(relationCounts ? { relationCounts, relationTotal } : {}),
    ...(eventCount !== undefined ? { eventCount } : {}),
    ...(lifecycleStates ? { lifecycleStates } : {}),
  };
}

/**
 * Manages .llmwiki/state.json — the persistent compilation state that tracks
 * source file hashes and their compiled concepts. Enables incremental
 * compilation by detecting which sources have changed since last compile.
 *
 * Uses atomic writes (write to .tmp, then rename) to prevent corruption from
 * interrupted processes (crash-consistent; not guaranteed durable across power
 * loss, as there is no fsync before the rename).
 *
 * VERSION GUARD (Phase 2, v2-aware reads): {@link KNOWN_STATE_VERSION} is the
 * highest schema version this build understands. {@link readStateClassified}
 * classifies a read into a {@link StateStatus} — `ok` / `missing` / `corrupt` /
 * `too-new` — without side effects, so read-only surfaces (freshness, lint,
 * view, export) can branch on the outcome. A `too-new` file (one whose `version`
 * exceeds the known version) is the FAIL-CLOSED case: the parsed state is carried
 * intact, nothing is written, and the recovering {@link readState} throws
 * {@link StateTooNewError} rather than starting fresh — which would clobber the
 * forward-incompatible layout on the next write. A `corrupt` (unparseable) file
 * is backed up to `.bak` and recovered as empty state instead.
 *
 * STORAGE. Every decision above is made HERE. The bytes are read, backed up and
 * written through the legacy-compatibility record binding
 * (`../storage/legacy-local-records.ts`); each root-taking function is its
 * `…From` / `…To` variant over the local-directory binding for that root.
 */

import { diskLocalRecords } from "../storage/disk-local-records.js";
import type { LegacyLocalRecords } from "../storage/legacy-local-records.js";
import { STATE_FILE } from "./constants.js";
import { note } from "./output.js";
import { classifyStateText, emptyState, KNOWN_STATE_VERSION, serializeState, type ClassifiedState } from "./state-shape.js";
import type { WikiState, SourceState } from "./types.js";

export { classifyStateText, emptyState, isPlainObject, KNOWN_STATE_VERSION, serializeState, syncEntityMirror, type ClassifiedState, type StateStatus } from "./state-shape.js";

/**
 * Thrown by {@link readState} when state.json was written by a newer-than-known
 * llmwiki version. Carries a distinct `.name` so callers can branch on the type
 * rather than string-matching the message.
 */
export class StateTooNewError extends Error {
  constructor(version: number) {
    super(
      `.llmwiki/state.json (version ${version}) was written by a newer llmwiki version ` +
        `(this build understands up to version ${KNOWN_STATE_VERSION}). ` +
        `Upgrade llmwiki to read this project.`,
    );
    this.name = "StateTooNewError";
  }
}

/**
 * Read .llmwiki/state.json and classify the outcome WITHOUT side effects.
 * Unlike readState(), this never writes a .bak on corrupt input, so read-only
 * callers (freshness/lint/view/export) can safely use it.
 */
export function readStateClassified(root: string): Promise<ClassifiedState> {
  return readStateClassifiedFrom(diskLocalRecords(root));
}

/** {@link readStateClassified}, with the record read through `records`. Still side-effect free. */
export async function readStateClassifiedFrom(records: LegacyLocalRecords): Promise<ClassifiedState> {
  if (!(await records.exists(STATE_FILE))) return { status: "missing", state: emptyState() };
  try {
    // A read error here (e.g. ELOOP on a symlinked state.json) falls through to
    // the catch and classifies CORRUPT — fail closed, never read-through. The
    // binding reads without following a leaf link, so a SYMLINKED state.json is
    // never read THROUGH to attacker-chosen out-of-tree bytes (which would feed
    // `concepts` / `frozenSlugs` into orphan path-joins).
    return classifyStateText(await records.readTextNoFollow(STATE_FILE));
  } catch (error) {
    // A segmented compile state's refusal (too large to materialize, unavailable) is not a corrupt FILE: it propagates.
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && code.startsWith("compile_state_")) throw error;
    return { status: "corrupt", state: emptyState() };
  }
}

/** Read .llmwiki/state.json, recovering from corruption gracefully (writes a .bak). */
export function readState(root: string): Promise<WikiState> {
  return readStateFrom(diskLocalRecords(root));
}

/** {@link readState}, with the record read and its corrupt copy backed up through `records`. */
export async function readStateFrom(records: LegacyLocalRecords): Promise<WikiState> {
  const classified = await readStateClassifiedFrom(records);
  if (classified.status === "too-new") {
    // Fail closed: never start fresh (which would clobber a forward-incompatible
    // file on the next write) and never copy a .bak.
    throw new StateTooNewError(classified.state.version as number);
  }
  if (classified.status === "corrupt") {
    const backup = STATE_FILE + ".bak";
    note(`⚠ Corrupt state.json — backed up to ${records.locate(backup)}, starting fresh.`);
    await records.copy(STATE_FILE, backup);
  }
  return classified.state;
}

/**
 * Atomically write state.json via the shared hardened {@link atomicWrite}
 * primitive (random O_EXCL temp + rename), so the state writer inherits the same
 * leaf-symlink write-escape defenses as every page write rather than carrying its
 * own bespoke temp+rename.
 */
export function writeState(root: string, state: WikiState): Promise<void> {
  return writeStateTo(diskLocalRecords(root), state);
}

/** {@link writeState}, with the serialized record written through `records`. */
export async function writeStateTo(records: LegacyLocalRecords, state: WikiState): Promise<void> {
  // Re-derive the v2 typed mirror at the single write choke point so no writer
  // can persist a desynced `entities` / `frozenEntities`. No-op for v1 states.
  await records.writeAtomic(STATE_FILE, serializeState(state));
}

/**
 * Pure in-memory transform: set a single source's entry on `state` (mutating it
 * in place) and return it. The SINGLE source of truth for the per-source merge,
 * shared by the incremental on-disk {@link updateSourceState} and the in-memory
 * compile draft so the two paths can never drift apart.
 */
export function applySourceState(
  state: WikiState,
  sourceFile: string,
  entry: SourceState,
): WikiState {
  state.sources[sourceFile] = entry;
  return state;
}

/**
 * Pure in-memory transform: remove a source entry from `state` (mutating it in
 * place) and return it. Shared by {@link removeSourceState} and the compile
 * draft for the same no-drift reason as {@link applySourceState}.
 */
export function removeSourceFrom(state: WikiState, sourceFile: string): WikiState {
  delete state.sources[sourceFile];
  return state;
}

/**
 * Pure in-memory transform: replace the frozen-slug set on `state` (mutating it
 * in place) and return it. Mirrors the frozen-persistence step of
 * `persistFrozenSlugs` (`{ ...state, frozenSlugs: [...] }`) so the disk path and
 * the compile draft share one frozen-list normalization.
 */
/**
 * Record the prompt-modifier digest this compile ran under, in place.
 *
 * Mirrors {@link applyFrozenSlugs}: an in-place transform shared by the draft
 * and any direct writer, so both paths persist the field the same way.
 */
export function applyPromptModifiers(state: WikiState, digest: string): WikiState {
  state.promptModifiers = digest;
  return state;
}

export function applyFrozenSlugs(state: WikiState, slugs: Set<string>): WikiState {
  state.frozenSlugs = Array.from(slugs);
  return state;
}

/**
 * Update a single source's entry in state after successful compilation.
 * Per-source granularity means interrupted compiles only reprocess incomplete sources.
 */
export async function updateSourceState(
  root: string,
  sourceFile: string,
  entry: SourceState,
): Promise<void> {
  const state = await readState(root);
  await writeState(root, applySourceState(state, sourceFile, entry));
}

/** Remove a source entry from state (for deleted sources). */
export async function removeSourceState(
  root: string,
  sourceFile: string,
): Promise<void> {
  const state = await readState(root);
  await writeState(root, removeSourceFrom(state, sourceFile));
}

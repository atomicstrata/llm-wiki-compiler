/**
 * @file src/scale/downgrade-units.ts
 * @description The EXPORT UNITS of an indexed scale-down: which incumbent
 * files the smaller layout needs, and the one routine that runs every export
 * against a sink factory, so the preview (counting sinks) and the stage
 * (writing sinks) produce the same bytes by construction.
 *
 * Units, in their fixed installation order: one per workspace operation
 * catalog (sorted by workspace id), the relation log, the event log, the
 * compile state (only when the segmented compile state is the authority:
 * otherwise `state.json` already is) and the vector store. PRIOR files are
 * every unit's path plus `.llmwiki/embeddings.json`: each one present is moved
 * aside before installation, so no stale incumbent file can become an
 * authority beside the exported one.
 *
 * Exports run strictly one after another; nothing accumulates across units.
 */

import { CompileStateError, MAX_STATE_FILE_BYTES } from "../cstate/contracts.js";
import { MAX_CATALOG_FILE_BYTES } from "../operation-bundles/constants.js";
import { EMBEDDINGS_FILE, MAX_EVENT_STORE_BYTES, MAX_RELATION_STORE_BYTES } from "../utils/constants.js";
import { MAX_BINARY_STORE_BYTES } from "../utils/embeddings-binary.js";
import type { DowngradeBlockerV1, DowngradeUnitV1 } from "./downgrade-contracts.js";
import { exportCompileState, exportEvents, exportRelations, exportWorkspaceCatalog, type ExportedEvents, type SinkFactory } from "./downgrade-export-history.js";
import { exportVectors } from "./downgrade-export-vectors.js";
import { DowngradeExportError, type ExportedFile } from "./downgrade-sink.js";

/** What the units of one project are made of. */
export interface UnitSources {
  /** Workspace ids holding a segmented operation catalog, sorted. */
  readonly workspaces: readonly string[];
  /** Whether the segmented compile state is the compile-state authority. */
  readonly segmentedState: boolean;
}

/** One unit's export routine. */
export interface UnitRoutine {
  readonly kind: DowngradeUnitV1["kind"];
  readonly workspaceId?: string;
  run(sinkFor: SinkFactory): Promise<ExportedFile>;
}

/** The export routines of `root`, in installation order. */
export function routinesOf(root: string, sources: UnitSources): UnitRoutine[] {
  const catalogs: UnitRoutine[] = sources.workspaces.map((workspaceId) => ({ kind: "catalog", workspaceId, run: (sinkFor) => exportWorkspaceCatalog(root, workspaceId, sinkFor) }));
  return [
    ...catalogs,
    { kind: "relations", run: (sinkFor) => exportRelations(root, sinkFor) },
    { kind: "events", run: (sinkFor) => exportEvents(root, sinkFor) },
    ...(sources.segmentedState ? [{ kind: "state" as const, run: (sinkFor: SinkFactory) => exportCompileState(root, sinkFor) }] : []),
    { kind: "vectors", run: (sinkFor) => exportVectors(root, sinkFor) },
  ];
}

/** The unit record of one finished export. */
function unitOf(routine: UnitRoutine, file: ExportedFile): DowngradeUnitV1 {
  return {
    kind: routine.kind, relPath: file.relPath, ...(routine.workspaceId === undefined ? {} : { workspaceId: routine.workspaceId }),
    present: file.present, bytes: file.bytes, sha256: file.sha256, records: file.records,
    ...(routine.kind === "events" ? { headDigest: (file as ExportedEvents).headDigest } : {}),
  };
}

/** The blocker an export refusal implies, or a rethrow for anything that is not a representation limit. */
function blockerOf(routine: UnitRoutine, error: unknown): DowngradeBlockerV1 {
  const what = routine.workspaceId === undefined ? routine.kind : `catalog of workspace ${routine.workspaceId}`;
  if (error instanceof DowngradeExportError && error.code !== "downgrade_export_mismatch") {
    return { code: error.code === "downgrade_export_too_large" ? "export_too_large" : "export_unsupported", detail: `${what}: ${error.message}` };
  }
  if (error instanceof CompileStateError && error.code === "compile_state_too_large") return { code: "export_too_large", detail: `${what}: ${error.message}` };
  throw error;
}

/**
 * Run every export of `root` against `sinkFor`, one after another. A unit the
 * smaller layout cannot represent (an export refusal, or a measured size past
 * its incumbent cap) is a blocker; any other fault throws.
 */
export async function runExports(root: string, sources: UnitSources, sinkFor: SinkFactory): Promise<{ units: DowngradeUnitV1[]; blockers: DowngradeBlockerV1[] }> {
  const units: DowngradeUnitV1[] = [];
  const blockers: DowngradeBlockerV1[] = [];
  for (const routine of routinesOf(root, sources)) {
    let file: ExportedFile;
    try { file = await routine.run(sinkFor); } catch (error) { blockers.push(blockerOf(routine, error)); continue; }
    const unit = unitOf(routine, file);
    // A counting sink measures past the cap; such a unit is reported with its real size and blocks.
    if (file.present && file.bytes > file.cap) blockers.push({ code: "export_too_large", detail: `${unit.relPath}: ${file.bytes} bytes exceed its ${file.cap}-byte incumbent cap` });
    units.push(unit);
  }
  return { units, blockers };
}

/** The prior files of `units`: every unit path plus the JSON embedding store, each once, in order. */
export function priorPathsOf(units: readonly DowngradeUnitV1[]): string[] {
  return [...new Set([...units.map((unit) => unit.relPath), EMBEDDINGS_FILE])];
}

/** The incumbent cap of a unit's file (the cap its export was written within). */
export function unitCap(kind: DowngradeUnitV1["kind"]): number {
  if (kind === "events") return MAX_EVENT_STORE_BYTES;
  if (kind === "relations") return MAX_RELATION_STORE_BYTES;
  if (kind === "catalog") return MAX_CATALOG_FILE_BYTES;
  return kind === "state" ? MAX_STATE_FILE_BYTES : MAX_BINARY_STORE_BYTES;
}

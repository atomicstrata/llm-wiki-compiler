/**
 * JSON export format writer.
 *
 * Produces a structured JSON document containing all wiki pages and their
 * metadata. The schema is intentionally simple and human-readable so it can
 * be consumed directly by scripts, agents, or downstream pipelines without
 * additional transformation.
 *
 * Schema:
 *   { schemaVersion, exportedAt, pageCount, projectId?, pages: ExportPage[] }
 *
 * W4 provenance lives PER PAGE (`ExportPage.modelId` / `promptVersion` plus
 * `contentHash` / `sourceHashes`), stamped into each page at compile time.
 * It is deliberately not summarized at the envelope level: a single
 * export-time model id would misattribute pages compiled under a different
 * model, which is exactly the lineage bug this avoids.
 *
 * `schemaVersion` lets downstream consumers (e.g. the rule importer) pin to a known
 * contract. Increment when a breaking field change lands; additive fields
 * do not require a bump.
 *
 * `projectId` is the optional bridge identifier. When present it pins the
 * on-disk export to a stable identity that downstream consumers (the
 * Atomic Memory adapter especially) use to derive deterministic external
 * IDs. Validation happens at the CLI/programmatic boundary, not here —
 * by the time we serialize, the value has been checked.
 */

import { validateProjectId } from "./project-id.js";
import type { ExportPage } from "./types.js";
import type { EntityPage } from "../profile/types.js";

/**
 * Monotonically-incremented envelope version.
 * Bump when a breaking field change lands; additive additions do not require a bump.
 */
export const EXPORT_SCHEMA_VERSION = 1;

/**
 * Additive, non-default-profile entity block for the JSON export.
 *
 * Present ONLY for a non-default profile; ABSENT for the built-in default so
 * the default export is byte-identical. `entityPages` carries the
 * content-bearing `EntityPage` shape directly — NOT the freshness/hash-decorated
 * `ExportPage`. The legacy `pages` array stays scoped to concepts/queries.
 */
export interface JsonExportProfileBlock {
  profileId: string;
  entityPages: EntityPage[];
  /** Human-readable collector problems; present ONLY when non-empty. */
  problems?: string[];
}

/** Top-level shape of the JSON export file. */
export interface JsonExportDocument {
  /**
   * Contract version for downstream consumers. Start at 1; increment only on
   * breaking envelope changes so consumers can pin a supported range.
   */
  schemaVersion: number;
  exportedAt: string;
  pageCount: number;
  /** Optional bridge identifier. See `src/export/project-id.ts` for the validation rule. */
  projectId?: string;
  pages: ExportPage[];
  /**
   * Non-default profile entity pages, ADDITIVELY. ABSENT (undefined) for the
   * built-in default so the default envelope is byte-identical.
   */
  profile?: JsonExportProfileBlock;
}

/** Options accepted by {@link buildJsonExportDocument}. */
export interface BuildJsonExportOptions {
  /**
   * Optional project identifier. Validated against the bridge contract
   * regex; throws if invalid so a malformed value never reaches disk.
   */
  projectId?: string;
  /**
   * Pre-computed non-default profile entity block. Supplied by the caller
   * (which holds `root`); ABSENT for the built-in default so the default
   * envelope gains no `profile` key.
   */
  profile?: JsonExportProfileBlock;
}

/**
 * Build the JSON export document object from a list of export pages.
 * @param pages - Sorted array of export pages.
 * @param options - Optional bridge envelope fields (e.g. `projectId`).
 * @returns The structured JsonExportDocument object (not serialized).
 */
export function buildJsonExportDocument(
  pages: ExportPage[],
  options: BuildJsonExportOptions = {},
): JsonExportDocument {
  const doc: JsonExportDocument = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    pageCount: pages.length,
    pages,
  };
  if (options.projectId !== undefined) {
    doc.projectId = validateProjectId(options.projectId);
  }
  if (options.profile !== undefined) {
    doc.profile = options.profile;
  }
  return doc;
}

/**
 * Build the JSON export document from a list of export pages.
 * @param pages - Sorted array of export pages.
 * @param options - Optional bridge envelope fields (e.g. `projectId`).
 * @returns Pretty-printed JSON string.
 */
export function buildJsonExport(
  pages: ExportPage[],
  options: BuildJsonExportOptions = {},
): string {
  return JSON.stringify(buildJsonExportDocument(pages, options), null, 2);
}

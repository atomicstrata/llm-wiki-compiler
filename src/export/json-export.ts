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
 * `schemaVersion` lets downstream consumers (e.g. Radar) pin to a known
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

/**
 * Monotonically-incremented envelope version.
 * Bump when a breaking field change lands; additive additions do not require a bump.
 */
export const EXPORT_SCHEMA_VERSION = 1;

/** Top-level shape of the JSON export file. */
interface JsonExportDocument {
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
}

/** Options accepted by {@link buildJsonExport}. */
export interface BuildJsonExportOptions {
  /**
   * Optional project identifier. Validated against the bridge contract
   * regex; throws if invalid so a malformed value never reaches disk.
   */
  projectId?: string;
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
  const doc: JsonExportDocument = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    pageCount: pages.length,
    pages,
  };
  if (options.projectId !== undefined) {
    doc.projectId = validateProjectId(options.projectId);
  }
  return JSON.stringify(doc, null, 2);
}

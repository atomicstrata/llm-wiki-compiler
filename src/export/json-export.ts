/**
 * JSON export format writer.
 *
 * Produces a structured JSON document containing all wiki pages and their
 * metadata. The schema is intentionally simple and human-readable so it can
 * be consumed directly by scripts, agents, or downstream pipelines without
 * additional transformation.
 *
 * Schema:
 *   { schemaVersion, exportedAt, pageCount, modelId, promptVersion,
 *     projectId?, pages: ExportPage[] }
 *
 * `modelId` and `promptVersion` are the W4 provenance stamp: they let a
 * downstream auditor tie compiled pages back to the model and prompt
 * generation that produced them. Per-page `contentHash` / `sourceHashes`
 * (on each ExportPage) complete the lineage. All are additive.
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
import { PROMPT_VERSION } from "../compiler/prompts.js";
import { resolveActiveModelId } from "../utils/provider.js";
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
  /**
   * Model id the compile pipeline would call (radar W4 provenance). Resolved
   * from the active LLM client config so a downstream auditor can tie pages
   * back to the exact model that produced them.
   */
  modelId: string;
  /**
   * Named version of the extraction + page-generation prompt contract
   * (radar W4 provenance). Bumped when prompt wording changes in a way that
   * could alter compiled content, so pages from different prompt generations
   * are distinguishable even under an identical model id.
   */
  promptVersion: string;
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
  /**
   * Override for the provenance `modelId` stamp. When omitted, the model id
   * is resolved from the active LLM client config via
   * {@link resolveActiveModelId}. Supplied explicitly by tests and by
   * callers that already know the compiling model.
   */
  modelId?: string;
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
    modelId: options.modelId ?? resolveActiveModelId(),
    promptVersion: PROMPT_VERSION,
    pages,
  };
  if (options.projectId !== undefined) {
    doc.projectId = validateProjectId(options.projectId);
  }
  return JSON.stringify(doc, null, 2);
}

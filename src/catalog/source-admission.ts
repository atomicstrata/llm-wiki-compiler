/**
 * @file src/catalog/source-admission.ts
 * @description Indexed source publication must fit the catalog's byte boundary.
 * Identity candidates must remain readable and have a valid explicit identity;
 * uncertain absence refuses instead of allocating a duplicate source name.
 */

import type { IoCounters } from "../segments/counters.js";
import { SOURCES_DIR } from "../utils/constants.js";
import { parseFrontmatterStatus } from "../utils/markdown.js";
import { MAX_CATALOG_FILE_BYTES, readCatalogFile } from "./files.js";

/** Stable operator errors for indexed source admission, retaining lower faults. */
class CatalogSourceAdmissionError extends Error {
  /** Preserve the refusal code and any underlying read/parser fault. */
  constructor(readonly code: "catalog_source_too_large" | "catalog_source_identity_unavailable", message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CatalogSourceAdmissionError";
  }
}

/** Refuse total UTF-8 document bytes the indexed catalog cannot represent. */
export function assertSourceDocumentFits(document: string): void {
  if (Buffer.byteLength(document, "utf8") > MAX_CATALOG_FILE_BYTES) {
    throw new CatalogSourceAdmissionError("catalog_source_too_large", "reduce the source to at most 16 MiB including its Markdown metadata before retrying");
  }
}

/** An uncertain identity is a repair requirement, never evidence of absence. */
export function sourceIdentityUnavailable(cause?: unknown): CatalogSourceAdmissionError {
  return new CatalogSourceAdmissionError("catalog_source_identity_unavailable", "cannot establish source identity; reconcile or repair the source inventory before retrying", cause);
}

/** Read and validate one indexed candidate without a legacy scan fallback. */
export async function readSourceIdentity(root: string, id: string, counters: IoCounters): Promise<string> {
  try {
    const text = await readCatalogFile(root, `${SOURCES_DIR}/${id}`, counters);
    if (text === null) throw sourceIdentityUnavailable();
    const parsed = parseFrontmatterStatus(text);
    if (!parsed.hasFrontmatterBlock || parsed.malformedFrontmatter || typeof parsed.meta.source !== "string" || parsed.meta.source.length === 0) {
      throw sourceIdentityUnavailable();
    }
    return parsed.meta.source;
  } catch (error) {
    if (error instanceof CatalogSourceAdmissionError) throw error;
    throw sourceIdentityUnavailable(error);
  }
}

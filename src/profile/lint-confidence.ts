/**
 * Declaration-aware confidence findings for collected profile entity pages.
 * Only an explicitly numeric confidence field opts into this stored-value
 * judgment; missing and malformed scalars remain the schema validator's concern.
 */

import type { LintResult } from "../linter/types.js";
import { LOW_CONFIDENCE_THRESHOLD } from "../utils/constants.js";
import type { EntityPage, EntityTypeDef } from "./types.js";

/** Return a warning when a declared, finite numeric confidence is below the threshold. */
export function checkDeclaredConfidence(page: EntityPage, definition: EntityTypeDef): LintResult[] {
  if (definition.fields?.confidence?.type !== "number") return [];
  const value = page.frontmatter.confidence;
  if (typeof value !== "number" || !Number.isFinite(value)) return [];
  if (value >= LOW_CONFIDENCE_THRESHOLD) return [];
  return [{
    rule: "low-confidence", severity: "warning", file: page.filePath,
    message: `Page confidence ${value.toFixed(2)} is below ${LOW_CONFIDENCE_THRESHOLD}`,
    entityType: page.entityType,
  }];
}

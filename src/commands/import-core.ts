// src/commands/import-core.ts
/** @file Leaf helper shared by the import command and the import core (avoids a command↔core cycle). */
import { validateWikiPage } from "../utils/markdown.js";
import type { MappedOkfPage } from "../import/types.js";

/** A mapped page is writable iff it has a non-empty slug and passes page validation. */
export function isWritable(page: MappedOkfPage): boolean {
  return page.slug.length > 0 && validateWikiPage(page.body);
}

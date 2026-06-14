/**
 * @file Determine which source files must be copied into the bundle's references/ subdir.
 *
 * Only files that appear in at least one page's citation list are included,
 * ensuring the references/ directory stays minimal and auditable. `resolveReferences`
 * is the single source of truth for WHICH cited files are actually bundled: a file is
 * kept only if it exists and realpaths inside `sources/`. Rendering keys citation links
 * off this same map, so a doc never links a `/references/` file that was not copied.
 */
import path from "path";
import { safeRealpath, isInsideDir } from "../../utils/path-confine.js";
import { SOURCES_DIR } from "../../utils/constants.js";
import type { ExportPage } from "../types.js";
import { safeRefName } from "./mapping.js";

/** A resolved, copyable reference: the confined source path + its safe bundle name. */
export interface ResolvedReference {
  /** Absolute realpath of the cited source file (confirmed inside sources/). */
  srcAbs: string;
  /** Safe, injective filename to write under references/. */
  destName: string;
}

/**
 * Collect the deduped set of cited source filenames across all pages.
 * These are the files that must be copied into the bundle's `references/` directory.
 *
 * @param pages - All pages in the export.
 * @returns Deduplicated array of source filenames (order is insertion order).
 */
export function collectReferenceFiles(pages: ExportPage[]): string[] {
  const files = new Set<string>();
  for (const page of pages) for (const c of page.citations ?? []) files.add(c.file);
  return [...files];
}

/**
 * Resolve the cited files that will actually be bundled. For each cited filename,
 * realpath `sources/<file>` and keep it ONLY if it exists and stays inside the
 * (canonicalized) sources directory — dropping missing files and any that escape
 * via symlink/traversal. The returned map is keyed by the ORIGINAL cited filename
 * so citation rendering can look up whether a file was bundled.
 *
 * @param root - llmwiki project root (sources/ lives here).
 * @param pages - All export pages whose citations name source files.
 * @returns Map from original cited filename to its {@link ResolvedReference}.
 */
export async function resolveReferences(
  root: string,
  pages: ExportPage[],
): Promise<Map<string, ResolvedReference>> {
  const resolved = new Map<string, ResolvedReference>();
  // Canonicalize sources dir so isInsideDir works on macOS (/private/var vs /var).
  const sourcesDir = (await safeRealpath(path.join(root, SOURCES_DIR))) ?? path.join(root, SOURCES_DIR);
  for (const file of collectReferenceFiles(pages)) {
    const realSrc = await safeRealpath(path.join(sourcesDir, file));
    if (!realSrc || !isInsideDir(realSrc, sourcesDir)) continue;
    resolved.set(file, { srcAbs: realSrc, destName: safeRefName(file) });
  }
  return resolved;
}

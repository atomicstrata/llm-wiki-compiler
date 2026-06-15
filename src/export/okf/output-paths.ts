/**
 * @file Decide each export page's bundle-relative output path. Native pages use
 * their slug-path; an imported foreign page restores its original `x-okf.okfPath`
 * when it is safe and uncontested, else falls back to its slug-path (with a warning).
 * An ownership map of every page's slug-path guarantees a foreign okfPath can never
 * steal any page's fallback location.
 */
import path from "node:path";
import { isInsideDir } from "../../utils/path-confine.js";
import type { ExportPage } from "../types.js";

/** Bundle-relative slug-path for a page. */
function slugPath(p: ExportPage): string {
  return `${p.pageDirectory}/${p.slug}.md`;
}

/** Cheap lexical pre-filter: is `okfPath` a safe bundle-relative target? (Realpath is enforced at write time.) */
export function isSafeOkfPath(okfPath: unknown, realOut: string): boolean {
  if (typeof okfPath !== "string" || okfPath.length === 0) return false;
  if (path.isAbsolute(okfPath)) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(okfPath)) return false; // only URL-safe path chars — spaces/parens/#/? would yield malformed links; fall back to the slug-path
  const segments = okfPath.split(/[/\\]+/);
  if (segments.includes("..") || segments.includes(".")) return false; // reject traversal AND current-dir segments (e.g. "./index.md" must not slip past the reserved-name check)
  if (!okfPath.endsWith(".md")) return false; // only markdown documents are round-trippable; reject non-.md / directory-like targets (e.g. "tables/customers", "tables/")
  if (okfPath === "index.md" || okfPath === "log.md") return false; // ROOT reserved (exact, not basename)
  if (okfPath === "references" || okfPath.startsWith("references/")) return false;
  return isInsideDir(path.normalize(path.join(realOut, okfPath)), realOut);
}

/** Total order over foreign pages: okfPath, then pageDirectory, then slug (stable, no equal-returns-1). */
function compareForeign(a: ExportPage, b: ExportPage): number {
  const ap = a.xOkf!.okfPath!, bp = b.xOkf!.okfPath!;
  if (ap !== bp) return ap < bp ? -1 : 1;
  if (a.pageDirectory !== b.pageDirectory) return a.pageDirectory < b.pageDirectory ? -1 : 1;
  if (a.slug !== b.slug) return a.slug < b.slug ? -1 : 1;
  return 0;
}

/** Resolve every page to a bundle-relative output path; returns the map + structured fallback warnings. */
export function resolveOutputPaths(
  pages: ExportPage[],
  realOut: string,
): { paths: Map<ExportPage, string>; warnings: string[] } {
  const owner = new Map<string, ExportPage>(); // slug-path -> owning page (slug-paths are unique)
  for (const p of pages) owner.set(slugPath(p), p);

  const paths = new Map<ExportPage, string>();
  const warnings: string[] = [];
  const used = new Set<string>();

  // Foreign pages first (deterministic), so a restored okfPath claims before fallbacks fill `used`.
  const foreign = pages.filter((p) => typeof p.xOkf?.okfPath === "string").sort(compareForeign);
  const native = pages.filter((p) => typeof p.xOkf?.okfPath !== "string");

  for (const p of foreign) {
    const okfPath = p.xOkf!.okfPath!;
    const ownerOfOkf = owner.get(okfPath);
    const usable = isSafeOkfPath(okfPath, realOut) && !used.has(okfPath) && (ownerOfOkf === undefined || ownerOfOkf === p);
    if (usable) {
      paths.set(p, okfPath);
      used.add(okfPath);
    } else {
      const sp = slugPath(p);
      paths.set(p, sp);
      used.add(sp);
      warnings.push(`OKF export: ${okfPath} not restorable (unsafe or collides); using ${sp}`);
    }
  }
  for (const p of native) {
    const sp = slugPath(p);
    paths.set(p, sp);
    used.add(sp);
  }
  return { paths, warnings };
}

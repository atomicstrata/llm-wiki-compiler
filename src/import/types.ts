/**
 * @file Shared types for the OKF import subsystem: the tolerantly-parsed source
 * doc shape, the mapped llmwiki page record, and the resource caps that bound
 * untrusted-bundle ingestion.
 */

/** A tolerantly-parsed OKF concept doc, ready for inverse mapping. */
export interface RawOkfDoc {
  /** Bundle-relative POSIX path, e.g. "concepts/a.md". */
  relPath: string;
  /** Parsed frontmatter (default safe YAML schema). */
  meta: Record<string, unknown>;
  /** Markdown body (frontmatter stripped). */
  body: string;
}

/** A llmwiki page produced from one OKF doc. */
export interface MappedOkfPage {
  slug: string;
  title: string;
  summary: string;
  sources: string[];
  targetDirectory: "concepts" | "queries";
  okfPath: string;
  /** Full page content (frontmatter + body) ready to write verbatim. */
  body: string;
}

/** Tunable resource caps for untrusted-bundle ingestion. */
export interface OkfImportLimits {
  maxFiles: number;
  maxDocBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
}

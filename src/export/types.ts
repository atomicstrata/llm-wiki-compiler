/**
 * Shared types for the llmwiki export subsystem.
 *
 * ExportPage is the normalised in-memory representation of a wiki page used
 * by every export format. It is derived from the page's YAML frontmatter plus
 * the wikilink graph extracted from the body.
 *
 * Trust-adjacent fields (`advisoryConfidence`, `provenanceState`,
 * `contradictedBy`) are surfaced as **advisory metadata only** — once the
 * export crosses into any downstream storage (Atomic Memory or otherwise),
 * those fields become mutable and lose their cryptographic tie to this
 * export. Consumers should treat them as the compiler's estimate at
 * export time, not as runtime guarantees.
 */

import type { PageKind } from "../schema/types.js";
import type { ProvenanceState, ContradictionRef } from "../utils/types.js";
import type { FlatCitation } from "../context/provenance.js";

/**
 * Flat citation shape exported alongside each page. Identical to the
 * normalized `FlatCitation` used by `llmwiki context` so adapters that
 * consume both surfaces share one shape. Paragraph-only citations omit
 * `start` and `end`; claim-level citations carry the parsed line range.
 */
export type ExportCitation = FlatCitation;

/**
 * Per-page freshness label. Always `"unverified"` in v1 — the bridge
 * cannot assert freshness relative to changed sources until the
 * source-freshness feature (roadmap P0) lands. Renamed from "unknown"
 * because consumers must act on stale data, not ignore it.
 */
export type AdvisoryFreshnessStatus = "unverified";

/**
 * Which wiki/ subdirectory a page lives in.
 *
 * Intentionally distinct from the schema layer's `PageKind`
 * (concept/entity/comparison/overview) — this is a filesystem location, not
 * a semantic typology. Renaming avoids field collision when JSON export and
 * schema metadata are consumed by the same downstream tooling.
 */
export type PageDirectory = "concepts" | "queries";

/** A fully-resolved wiki page ready for export serialisation. */
export interface ExportPage {
  /** Human-readable page title (from frontmatter). */
  title: string;
  /** Filesystem slug (filename without .md). */
  slug: string;
  /** Whether this page came from wiki/concepts or wiki/queries. */
  pageDirectory: PageDirectory;
  /**
   * Project-relative path to the source markdown file, e.g.
   * `wiki/concepts/retrieval.md`. Surfaced for the bridge so downstream
   * adapters can deep-link without reconstructing the path themselves.
   */
  path: string;
  /** One-line page summary (from frontmatter). */
  summary: string;
  /** Source filenames cited in the page body. */
  sources: string[];
  /** Taxonomy tags (from frontmatter). */
  tags: string[];
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-updated timestamp. */
  updatedAt: string;
  /** Slugs of other pages this page links to via [[wikilinks]]. */
  links: string[];
  /** Full markdown body (without frontmatter). */
  body: string;
  /**
   * Optional typed page kind from frontmatter. Defaults to "concept" in
   * downstream consumers when absent — the export omits the field if no
   * `kind` was set on the wiki page rather than fabricating a default.
   */
  kind?: PageKind;
  /**
   * Compiler's confidence estimate at export time. Advisory only —
   * once imported into any downstream store this field is mutable and
   * not cryptographically bound to the export.
   */
  advisoryConfidence?: number;
  /** Lifecycle state from the compiler's provenance metadata. Advisory only. */
  provenanceState?: ProvenanceState;
  /** Other pages flagged as contradicting this one. Advisory only. */
  contradictedBy?: ContradictionRef[];
  /**
   * Claim citations from the page body, flattened to the shared bridge
   * shape. One entry per `^[file:start-end]` span. Multi-source markers
   * (`^[a.md, b.md]`) expand into multiple entries. Paragraph-only
   * citations carry no line range.
   */
  citations: ExportCitation[];
  /**
   * Prior external IDs this page was known by (e.g. before a slug
   * rename). Downstream importers treat any matching alias as an
   * upsert target so renamed pages do not orphan their prior memory
   * record.
   */
  aliases?: string[];
  /**
   * Per-page freshness status. Always `"unverified"` in v1 — the bridge
   * cannot assert source-freshness until that feature ships.
   */
  advisoryFreshnessStatus: AdvisoryFreshnessStatus;
  /**
   * Deterministic SHA-256 (hex) of {@link ExportPage.body}. Lets a
   * downstream auditor (radar W4) detect content drift and verify that an
   * imported page still matches what the compiler exported, without
   * re-reading the markdown. Stable for identical bodies.
   */
  contentHash: string;
  /**
   * SHA-256 hashes of the source files this page derived from — the same
   * per-source digests the compiler records in `.llmwiki/state.json` for
   * change detection. Resolved from the page's `sources` list; ordered and
   * de-duplicated. Empty when a page has no recorded sources (e.g. seed
   * pages). Lets an auditor tie a page back to exact source bytes.
   */
  sourceHashes: string[];
}

/**
 * Source filter for marp export: which page kinds to include.
 * "all" includes both concepts and queries (the default).
 */
export type MarpSource = "concepts" | "queries" | "all";

/** All recognised marp source values — used for validation. */
export const MARP_SOURCES: readonly MarpSource[] = ["concepts", "queries", "all"];

/** Supported export target identifiers. */
export type ExportTarget =
  | "llms-txt"
  | "llms-full-txt"
  | "json"
  | "json-ld"
  | "graphml"
  | "marp";

/** All recognised export target names — used for validation. */
export const EXPORT_TARGETS: readonly ExportTarget[] = [
  "llms-txt",
  "llms-full-txt",
  "json",
  "json-ld",
  "graphml",
  "marp",
];

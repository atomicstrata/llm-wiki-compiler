/**
 * @file Types for the OKF v0.1 export. `x-llmwiki` is llmwiki's producer
 * namespace (OKF allows producer keys; consumers preserve them).
 */
import type { FlatCitation } from "../../context/provenance.js";

/** llmwiki compiler provenance carried losslessly inside OKF frontmatter. */
export interface XLlmwiki {
  schemaVersion: "0.1";
  /** sha256 of the CANONICAL body (= body minus derived `# Citations`); see mapping.hashCanonicalBody. */
  contentHash: string;
  /** Source page directory — the unambiguous signal import uses for `targetDirectory`. */
  pageDirectory: "concepts" | "queries";
  sources?: string[];
  confidence?: number;
  provenanceState?: string;
  contradictedBy?: unknown[];
  freshnessStatus?: string;
  aliases?: string[];
  citations?: FlatCitation[];
  okfPath?: string; // set on import; absent on export
}

/** OKF concept-doc frontmatter: standard fields + the x-llmwiki block. */
export interface OkfFrontmatter {
  type: string; // REQUIRED, non-empty
  title?: string;
  description?: string;
  tags?: string[];
  timestamp?: string;
  "x-llmwiki": XLlmwiki;
}

/** Resolves a wikilink slug to its bundle location + title (or null if unknown). */
export type LinkResolver = (slug: string) => { dir: "concepts" | "queries"; title: string } | null;

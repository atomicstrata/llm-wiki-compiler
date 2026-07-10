/**
 * @file src/connectors/impl/crossref.ts
 * @description First-party Crossref DOI metadata connector.
 */
import type { ConnectorDef, ConnectorDraft } from "../types.js";

/** Remove URL/doi prefixes from DOI-ish input while preserving the DOI body. */
function stripDoiPrefix(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:/i, "");
}

/** Normalize DOI-ish input into the canonical lower-case source id. */
function canonicalDoi(value: string): string {
  return stripDoiPrefix(value).toLowerCase();
}

/** Remove JATS/HTML-ish tags from Crossref text fields. */
function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/** Return the first string in a Crossref array field, or an empty string. */
function firstString(value: unknown): string {
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
}

/** Extract a publication year from Crossref date-parts. */
function yearOf(message: Record<string, unknown>): number | undefined {
  const published = message["published-print"] ?? message["published-online"] ?? message.issued;
  const parts = (published as { "date-parts"?: unknown } | undefined)?.["date-parts"];
  const year = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0][0] : undefined;
  return Number.isInteger(year) ? year as number : undefined;
}

/** Normalize Crossref author rows into display names. */
function authorsOf(message: Record<string, unknown>): string[] {
  const authors = Array.isArray(message.author) ? message.author : [];
  return authors.map(authorName).filter(Boolean);
}

/** Build one author display name from the Crossref person object. */
function authorName(value: unknown): string {
  const row = value as Record<string, unknown>;
  return [row.given, row.family].filter((part): part is string => typeof part === "string").join(" ");
}

/** Parse the top-level Crossref work response envelope. */
function workMessage(body: string): Record<string, unknown> {
  const parsed = JSON.parse(body) as { message?: Record<string, unknown> };
  return parsed.message ?? {};
}

/** Build the connector draft from one Crossref work response. */
function parseCrossrefWork(body: string): ConnectorDraft[] {
  const message = workMessage(body);
  const abstract = stripTags(typeof message.abstract === "string" ? message.abstract : "");
  return [{
    fields: {
      title: firstString(message.title),
      doi: typeof message.DOI === "string" ? canonicalDoi(message.DOI) : "",
      authors: authorsOf(message),
      year: yearOf(message),
      abstract,
      stage: "imported",
    },
    content: abstract,
  }];
}

/** First-party DOI metadata connector backed by Crossref's works endpoint. */
export const crossrefConnector: ConnectorDef = {
  id: "crossref",
  version: "1",
  allowedHosts: ["api.crossref.org"],
  inputs: ["doi"],
  draftFields: ["title", "doi", "authors", "year", "abstract", "stage"],
  templateInstallable: true,
  minRequestIntervalMs: 1000,
  requiresContactEmail: true,
  buildRequest(inputs) {
    const doi = stripDoiPrefix(String(inputs.doi ?? ""));
    return {
      url: `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
      contentTypes: ["application/json"],
    };
  },
  canonicalSourceId(inputs) {
    return canonicalDoi(String(inputs.doi ?? ""));
  },
  parse: parseCrossrefWork,
};

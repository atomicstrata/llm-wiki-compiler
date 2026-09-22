/**
 * @file src/utils/store-header.ts
 * @description Shared header-line helpers for the header-versioned JSONL stores
 * (relations, events). One definition splits the raw store bytes into the header
 * line and the exact remaining record bytes, and parses a header's declared
 * schema version, so the relation and event operation-version upgrades preserve
 * record bytes identically.
 */

/** Split raw store bytes into the header line and the exact remaining record bytes. */
export function splitStoreHeaderLine(raw: string): { headerLine: string; recordBytes: string } | null {
  const newline = raw.indexOf("\n");
  if (newline === -1) return null;
  return { headerLine: raw.slice(0, newline), recordBytes: raw.slice(newline + 1) };
}

/** Parse a header line's declared schema version for the expected header kind. */
export function parseStoreHeaderVersion(line: string, kind: string): number | null {
  try {
    const parsed = JSON.parse(line) as { kind?: unknown; schemaVersion?: unknown };
    if (parsed.kind !== kind || typeof parsed.schemaVersion !== "number") return null;
    return parsed.schemaVersion;
  } catch {
    return null;
  }
}

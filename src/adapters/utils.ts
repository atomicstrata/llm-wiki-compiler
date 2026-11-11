/**
 * Shared utilities for session adapters.
 *
 * These helpers are used by multiple adapters to avoid code duplication
 * for common operations like title truncation and JSON file parsing.
 */

/** Maximum title characters before truncation with an ellipsis. */
const MAX_TITLE_CHARS = 80;

/**
 * Truncate a string to `MAX_TITLE_CHARS` and append an ellipsis if needed.
 * @param text - The input string to truncate.
 */
function truncateTitle(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_TITLE_CHARS
    ? trimmed.slice(0, MAX_TITLE_CHARS).trimEnd() + "…"
    : trimmed;
}

/**
 * Derive a session title from an optional raw title or a fallback default.
 * Falls back to the first line of `firstUserContent` when `rawTitle` is absent,
 * and to `defaultTitle` when both are unavailable.
 *
 * @param rawTitle - Optional title from session metadata.
 * @param firstUserContent - Content of the first user turn (for fallback).
 * @param defaultTitle - Adapter-specific default (e.g. "Claude Session").
 */
export function resolveSessionTitle(
  rawTitle: string | undefined,
  firstUserContent: string | undefined,
  defaultTitle: string,
): string {
  if (rawTitle && rawTitle.trim().length > 0) return truncateTitle(rawTitle);
  if (firstUserContent) {
    const firstLine = firstUserContent.split("\n")[0];
    if (firstLine.trim().length > 0) return truncateTitle(firstLine);
  }
  return defaultTitle;
}

/**
 * Parse JSON from `raw`, throwing an actionable error on failure.
 * @param raw - Raw JSON string.
 * @param filePath - Used in the error message to identify the file.
 */
function parseJsonOrThrow(raw: string, filePath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in session file: ${filePath}`);
  }
}

/**
 * Read a session export from disk and parse it as JSON.
 * @param filePath - Path to the export file.
 * @returns The parsed JSON value.
 * @throws When the file cannot be read, or with a message naming the file when it is not valid JSON.
 */
export async function readSessionJson(filePath: string): Promise<unknown> {
  return parseJsonOrThrow(await Bun.file(filePath).text(), filePath);
}

/**
 * Explicit source-selection policy. Recursion is opt-in; exclusions are literal
 * source-relative prefixes, not a second glob language or a temporary pause.
 */
import path from "node:path";
import { loadProjectConfig, normalizeProjectConfig, ProjectConfigError, requireConfigRecord } from "../project/config.js";

/** Normalized project source discovery settings. */
export interface SourceSelection {
  recursive: boolean;
  exclude: string[];
}

/** Normalize portable exclusion paths without interpreting glob syntax. */
function normalizeExclusion(value: unknown): string {
  if (typeof value !== "string") throw new ProjectConfigError("sources.exclude entries must be strings");
  const name = value.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!name || path.posix.isAbsolute(name) || path.win32.isAbsolute(name) || /[\\\0:*?]/.test(name) ||
      name.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ProjectConfigError(`Invalid source-relative exclusion: ${JSON.stringify(value)}`);
  }
  return name;
}

/** Load source settings without interfering with sibling review configuration. */
export async function loadSourceSelection(root: string): Promise<SourceSelection> {
  const config = await loadProjectConfig(root);
  if (config?.sources === undefined) return { recursive: false, exclude: [] };
  normalizeProjectConfig(config);
  const sources = requireConfigRecord(config.sources, "sources");
  if (sources.recursive !== undefined && typeof sources.recursive !== "boolean") {
    throw new ProjectConfigError("sources.recursive must be a boolean");
  }
  if (sources.exclude !== undefined && !Array.isArray(sources.exclude)) {
    throw new ProjectConfigError("sources.exclude must be an array");
  }
  const exclude = ((sources.exclude ?? []) as unknown[]).map(normalizeExclusion);
  return { recursive: sources.recursive === true, exclude: [...new Set(exclude)] };
}

/** Match exact paths or descendants, never similarly named sibling directories. */
export function isSourceExcluded(id: string, selection: SourceSelection): boolean {
  return selection.exclude.some((name) => id === name || id.startsWith(`${name}/`));
}

/** Whether a source-relative key participates in the configured compile universe. */
export function isSourceSelected(id: string, selection: SourceSelection): boolean {
  return (selection.recursive || !id.includes("/")) && !isSourceExcluded(id, selection);
}

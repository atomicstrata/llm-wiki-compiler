/**
 * Schema config loader.
 *
 * Discovers a project's schema file from a fixed list of candidate paths,
 * parses it (JSON or YAML), and merges it onto the default schema. Missing
 * files are not an error — the compiler falls back to defaults so existing
 * projects continue to work without any migration.
 */

import path from "path";
import { diskLocalReads } from "../storage/disk-local-reads.js";
import type { LegacyLocalReads } from "../storage/legacy-local-reads.js";
import type {
  PageKind,
  PageKindRule,
  PartialSchemaFile,
  SchemaConfig,
  SeedPage,
  TimelineSchema,
} from "./types.js";
import { PAGE_KINDS } from "./types.js";
import { buildDefaultSchema } from "./defaults.js";

/** Candidate schema file paths searched in priority order. */
const SCHEMA_CANDIDATE_PATHS = [
  ".llmwiki/schema.json",
  ".llmwiki/schema.yaml",
  ".llmwiki/schema.yml",
  "wiki/.schema.yaml",
  "wiki/.schema.yml",
];

/** Find the first existing schema candidate path, in priority order, or null. */
async function findSchemaPath(reads: LegacyLocalReads): Promise<string | null> {
  for (const candidate of SCHEMA_CANDIDATE_PATHS) {
    if (await reads.exists(candidate)) return candidate;
  }
  return null;
}

/** Decide whether to parse the file as JSON or YAML based on its extension. */
function parseSchemaFile(filePath: string, content: string): PartialSchemaFile {
  const isJson = filePath.endsWith(".json");
  const parsed: unknown = isJson ? JSON.parse(content) : Bun.YAML.parse(content);
  if (parsed && typeof parsed === "object") return parsed as PartialSchemaFile;
  return {};
}

/** Type-guard checking whether a string is one of the supported page kinds. */
function isPageKind(value: unknown): value is PageKind {
  return typeof value === "string" && (PAGE_KINDS as readonly string[]).includes(value);
}

/** Merge a single per-kind rule from the file onto the default rule. */
function mergeKindRule(
  defaults: PageKindRule,
  override: Partial<PageKindRule> | undefined,
): PageKindRule {
  if (!override) return defaults;
  const minWikilinks = typeof override.minWikilinks === "number"
    ? override.minWikilinks
    : defaults.minWikilinks;
  const description = typeof override.description === "string"
    ? override.description
    : defaults.description;
  return { minWikilinks, description };
}

/** Merge per-kind rule overrides onto the default rule table. */
function mergeKinds(
  defaults: Record<PageKind, PageKindRule>,
  overrides: PartialSchemaFile["kinds"],
): Record<PageKind, PageKindRule> {
  const merged = { ...defaults };
  if (!overrides) return merged;

  for (const kind of PAGE_KINDS) {
    merged[kind] = mergeKindRule(defaults[kind], overrides[kind]);
  }
  return merged;
}

/** Validate and coerce a single seed page entry. Returns null when invalid. */
function normalizeSeedPage(entry: Partial<SeedPage>): SeedPage | null {
  if (typeof entry.title !== "string" || entry.title.trim() === "") return null;
  if (!isPageKind(entry.kind)) return null;
  const summary = typeof entry.summary === "string" ? entry.summary : "";
  const relatedSlugs = Array.isArray(entry.relatedSlugs)
    ? entry.relatedSlugs.filter((slug): slug is string => typeof slug === "string")
    : undefined;
  return { title: entry.title, kind: entry.kind, summary, relatedSlugs };
}

/** Coerce raw seed page entries into validated SeedPage objects. */
function normalizeSeedPages(entries: PartialSchemaFile["seedPages"]): SeedPage[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map(normalizeSeedPage)
    .filter((entry): entry is SeedPage => entry !== null);
}

/**
 * The timeline settings: `enabled` only when literally true. An unknown zone is
 * an error rather than a silent fallback, because it would put events on the
 * wrong day without anyone noticing.
 */
function normalizeTimeline(defaults: TimelineSchema, entry: PartialSchemaFile["timeline"]): TimelineSchema {
  if (!entry || typeof entry !== "object") return defaults;
  const zone = entry.timeZone;
  if (zone !== undefined && (typeof zone !== "string" || !isKnownTimeZone(zone))) {
    throw new Error(`schema timeline.timeZone ${JSON.stringify(zone)} is not a known IANA time zone (e.g. "America/New_York")`);
  }
  return { enabled: entry.enabled === true, timeZone: zone ?? defaults.timeZone };
}

/** Whether the runtime recognises an IANA zone name. */
function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Apply a parsed partial-schema onto the defaults, returning the resolved config. */
function applyOverrides(
  defaults: SchemaConfig,
  overrides: PartialSchemaFile,
  loadedFrom: string,
): SchemaConfig {
  const defaultKind = isPageKind(overrides.defaultKind)
    ? overrides.defaultKind
    : defaults.defaultKind;
  return {
    version: 1,
    defaultKind,
    kinds: mergeKinds(defaults.kinds, overrides.kinds),
    seedPages: normalizeSeedPages(overrides.seedPages),
    timeline: normalizeTimeline(defaults.timeline, overrides.timeline),
    loadedFrom,
  };
}

/**
 * Load the schema for `root`, falling back to defaults when no file is present.
 * Throws on parse failure so the user sees a clear error rather than a silent
 * default — silent fallback would mask real config bugs.
 * @param root - Project root directory.
 * @returns Resolved schema config.
 */
export function loadSchema(root: string): Promise<SchemaConfig> {
  return loadSchemaFrom(diskLocalReads(root));
}

/**
 * The same schema, read through `reads`. Parse errors keep naming the located
 * path, so a local project's messages still carry the file's absolute path.
 */
export async function loadSchemaFrom(reads: LegacyLocalReads): Promise<SchemaConfig> {
  const defaults = buildDefaultSchema();
  const schemaPath = await findSchemaPath(reads);
  if (!schemaPath) return defaults;

  const raw = await reads.readText(schemaPath);
  return schemaFromText(reads.locate(schemaPath), raw);
}

/**
 * Resolve a schema from text already read, or the defaults when there is none.
 * A reader with no filesystem uses this so its schema is merged and normalized
 * by the same code as a local project's.
 *
 * @param schemaName - The schema's file name; its extension selects JSON or YAML.
 * @param raw - The schema text, or `null` when the project declares no schema.
 */
function schemaFromText(schemaName: string, raw: string | null): SchemaConfig {
  const defaults = buildDefaultSchema();
  if (raw === null) return defaults;
  return applyOverrides(defaults, parseSchemaFile(schemaName, raw), schemaName);
}

/** Expose candidate paths so the CLI `schema init` command can pick one. */
export function defaultSchemaInitPath(root: string): string {
  return path.join(root, SCHEMA_CANDIDATE_PATHS[0]);
}

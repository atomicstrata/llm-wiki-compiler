/**
 * @file src/entities/identity.ts
 * @description Which extracted names are the same record. Wrong merges are
 * worse than duplicates, so nothing here guesses:
 *
 *  - The registry, `.llmwiki/aliases.json`, is the owner's word. Every name it
 *    lists under a record id is that record, and the owner's own names are never
 *    a record at all:
 *      { "owner": { "type": "person", "names": ["Sam", "Sam Rivera"] },
 *        "entities": { "person": { "alex-kim": ["Alex", "Alex Kim"] } } }
 *  - Otherwise a name is its own record: names that normalize the same (case,
 *    accents, spacing) are one record, and any other name is a different one,
 *    even when both make the same slug: the later one's id gets a suffix.
 *  - Names the registry lists under `exclude` are not records of that type:
 *    people only mentioned in passing, such as public figures, or names the
 *    model took for a person that are not one.
 *      { "exclude": { "person": ["Donald Trump", "Acme Corp"] } }
 *  - The owner's hub page has an id of its own that no record takes.
 *  - Records that MIGHT be the same (one name is another's first name, or two
 *    share a first name) are flagged both ways for the owner to settle in the
 *    registry, never merged.
 */

import { slugify } from "../utils/markdown.js";
import type { LineRange } from "../timeline/event-days.js";

/** The owner's alias registry. */
export interface AliasRegistry {
  owner?: { type: string; names: string[] };
  /** Entity type → record id → the names that are that record. */
  entities: Record<string, Record<string, string[]>>;
  /** Entity type → names that are not records of that type. */
  exclude?: Record<string, string[]>;
}

/** One record as one source names it. */
export interface Mention {
  file: string;
  name: string;
  fields: Record<string, unknown>;
  lines: LineRange[];
}

/** One record after identity: its id, every name it went by, and every mention. */
export interface ResolvedRecord {
  id: string;
  names: string[];
  mentions: Mention[];
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
/** Longest record id; a longer one is cut and given a hash so it stays unique and fits a filename. */
const MAX_ID_LENGTH = 80;

/**
 * Read the registry text, or an empty registry when there is none. Malformed
 * JSON, an `exclude` that is not a map of type → list of names, or a name both
 * excluded and registered throws, so a mistake is never silently ignored.
 */
export function parseRegistry(text: string | null): AliasRegistry {
  if (text === null) return { entities: {} };
  const raw = JSON.parse(text) as Partial<Record<keyof AliasRegistry, unknown>> & { owner?: { type?: unknown; names?: unknown } };
  const owner = raw.owner && typeof raw.owner.type === "string" && Array.isArray(raw.owner.names)
    ? { type: raw.owner.type, names: strings(raw.owner.names) } : undefined;
  const entities: AliasRegistry["entities"] = {};
  for (const [type, records] of Object.entries((raw.entities ?? {}) as Record<string, Record<string, unknown>>)) {
    entities[type] = Object.fromEntries(Object.entries(records ?? {})
      .filter(([id, names]) => SLUG.test(id) && Array.isArray(names))
      .map(([id, names]) => [id, strings(names)]));
  }
  const exclude = parseExclude(raw.exclude);
  assertNotBoth(entities, exclude);
  return { ...(owner ? { owner } : {}), entities, ...(Object.keys(exclude).length > 0 ? { exclude } : {}) };
}

/** The strings in a list, ignoring anything else. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** `exclude` as type → names; anything but a map of lists throws. */
function parseExclude(value: unknown): Record<string, string[]> {
  if (value === undefined) return {};
  const isMap = typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isMap || !Object.values(value).every(Array.isArray)) throw new Error('"exclude" must map each entity type to a list of names');
  return Object.fromEntries(Object.entries(value).map(([type, names]) => [type, strings(names)]));
}

/** Throw when a name is both excluded and registered under a record id of the same type. */
function assertNotBoth(entities: AliasRegistry["entities"], exclude: Record<string, string[]>): void {
  for (const [type, names] of Object.entries(exclude)) {
    const excluded = new Set(names.map(normalizeName));
    for (const [id, registered] of Object.entries(entities[type] ?? {})) {
      const both = registered.find((name) => excluded.has(normalizeName(name)));
      if (both) throw new Error(`"${both}" is both excluded and registered under ${type} "${id}"`);
    }
  }
}

/** A name compared without case, accents, punctuation or extra spacing. */
function normalizeName(name: string): string {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
}

/** A slug-safe id for a name: ASCII-folded and at most {@link MAX_ID_LENGTH} long, or a short hash when nothing slug-safe is left. */
export function recordId(name: string): string {
  const folded = slugify(name.normalize("NFKD").replace(/\p{M}/gu, "")).replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");
  if (!SLUG.test(folded)) return `record-${nameHash(name)}`;
  return folded.length <= MAX_ID_LENGTH ? folded : `${folded.slice(0, MAX_ID_LENGTH - 8).replace(/-+$/, "")}-${nameHash(name)}`;
}

/** A short, stable hash of a name. */
function nameHash(name: string): string {
  let hash = 0;
  for (const char of normalizeName(name)) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash.toString(36);
}

/** The id of the owner's hub page in `type`, or null when the owner is not of that type. */
export function hubId(registry: AliasRegistry, type: string): string | null {
  const name = registry.owner?.type === type ? registry.owner.names[0] : undefined;
  if (!name) return null;
  const id = recordId(name);
  return registry.entities[type]?.[id] ? `${id}-owner` : id;
}

/**
 * Group one type's mentions into records: registry names first, then exact
 * normalized names. Each record gets its own id: a registry id as given, else
 * its name's slug, with a numbered suffix when another record or the hub has it.
 */
export function resolveRecords(type: string, mentions: Mention[], registry: AliasRegistry): ResolvedRecord[] {
  const taken = new Set([...Object.keys(registry.entities[type] ?? {}), ...[hubId(registry, type) ?? []].flat()]);
  // Excluded names still take their ids here, so excluding one never renames another record.
  return [...groupMentions(type, mentions, registry)].sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => ({ group, id: group.registered ?? uniqueId(recordId(group.names[0]), taken) }))
    .filter(({ group }) => !group.excluded)
    .map(({ group, id }) => ({ id, names: group.names, mentions: group.mentions }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** One record's mentions before it has an id: the registry id it has, if any, whether it is excluded, and the names it went by. */
interface MentionGroup { registered?: string; excluded: boolean; names: string[]; mentions: Mention[] }

/** Mentions grouped by registry id, else by normalized name, with excluded names marked; the owner's names are left out. */
function groupMentions(type: string, mentions: Mention[], registry: AliasRegistry): Map<string, MentionGroup> {
  const { owner, excluded, known } = registryIndex(type, registry);
  const groups = new Map<string, MentionGroup>();
  for (const mention of mentions) {
    const key = normalizeName(mention.name);
    if (!key || owner.has(key)) continue;
    const registered = known.get(key);
    const groupKey = registered ? `id:${registered}` : `name:${key}`;
    const group = groups.get(groupKey) ?? { registered, excluded: excluded.has(key), names: [], mentions: [] };
    if (!group.names.includes(mention.name.trim())) group.names.push(mention.name.trim());
    group.mentions.push(mention);
    groups.set(groupKey, group);
  }
  return groups;
}

/** The registry for one type, by normalized name: the owner's names, the excluded names, and each registered name's id. */
function registryIndex(type: string, registry: AliasRegistry): { owner: Set<string>; excluded: Set<string>; known: Map<string, string> } {
  const owner = new Set((registry.owner?.type === type ? registry.owner.names : []).map(normalizeName));
  const excluded = new Set((registry.exclude?.[type] ?? []).map(normalizeName));
  const known = new Map<string, string>();
  for (const [id, names] of Object.entries(registry.entities[type] ?? {})) for (const name of names) known.set(normalizeName(name), id);
  return { owner, excluded, known };
}

/** `base`, or `base-2`, `base-3`… the first one not yet taken; marks it taken. */
function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let suffix = 2; taken.has(id); suffix++) id = `${base}-${suffix}`;
  taken.add(id);
  return id;
}

/**
 * The name a record is shown under: the registry's first name for it, else its
 * fullest, most-used name, preferring one written with capitals. A name only ever
 * written in lowercase (common in chats) is shown with each word capitalized; the
 * spellings as written stay in the record's names.
 */
export function displayName(record: ResolvedRecord, registered: string[] | undefined): string {
  if (registered?.[0]) return registered[0];
  const uses = new Map<string, number>();
  for (const mention of record.mentions) uses.set(mention.name.trim(), (uses.get(mention.name.trim()) ?? 0) + 1);
  const capitalized = (name: string): number => (name === name.toLowerCase() ? 0 : 1);
  const [chosen] = [...uses].sort(([a, x], [b, y]) =>
    b.split(" ").length - a.split(" ").length || capitalized(b) - capitalized(a) || y - x || a.localeCompare(b))[0];
  return capitalized(chosen) ? chosen : chosen.replace(/(^|\s)(\p{Ll})/gu, (_match, space: string, letter: string) => space + letter.toUpperCase());
}

/** Record id → ids of records that might be the same one: a shared first name, or one name being another's first name. */
export function possibleDuplicates(records: ResolvedRecord[]): Map<string, string[]> {
  const firstNames = new Map<string, Set<string>>();
  for (const record of records) {
    for (const name of record.names) {
      const first = normalizeName(name).split(" ")[0];
      if (first) firstNames.set(first, (firstNames.get(first) ?? new Set()).add(record.id));
    }
  }
  const flags = new Map<string, string[]>();
  for (const ids of firstNames.values()) {
    if (ids.size < 2) continue;
    for (const id of ids) flags.set(id, [...new Set([...(flags.get(id) ?? []), ...[...ids].filter((other) => other !== id)])].sort());
  }
  return flags;
}

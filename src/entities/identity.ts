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
 *    accents, spacing) are one record, and any other name is a different one.
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

/** Read the registry text, or an empty registry when there is none. Malformed text throws, naming the file. */
export function parseRegistry(text: string | null): AliasRegistry {
  if (text === null) return { entities: {} };
  const raw = JSON.parse(text) as Partial<AliasRegistry>;
  const owner = raw.owner && typeof raw.owner.type === "string" && Array.isArray(raw.owner.names) ? raw.owner : undefined;
  const entities: AliasRegistry["entities"] = {};
  for (const [type, records] of Object.entries(raw.entities ?? {})) {
    entities[type] = Object.fromEntries(Object.entries(records ?? {}).filter(([id, names]) => SLUG.test(id) && Array.isArray(names)));
  }
  return { ...(owner ? { owner } : {}), entities };
}

/** A name compared without case, accents, punctuation or extra spacing. */
function normalizeName(name: string): string {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
}

/** A slug-safe id for a name: ASCII-folded, or a short hash when nothing slug-safe is left. */
export function recordId(name: string): string {
  const folded = slugify(name.normalize("NFKD").replace(/\p{M}/gu, "")).replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");
  if (SLUG.test(folded)) return folded;
  let hash = 0;
  for (const char of normalizeName(name)) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return `record-${hash.toString(36)}`;
}

/** Group one type's mentions into records: registry names first, then exact normalized names. */
export function resolveRecords(type: string, mentions: Mention[], registry: AliasRegistry): ResolvedRecord[] {
  const owner = new Set(registry.owner?.type === type ? registry.owner.names.map(normalizeName) : []);
  const known = new Map<string, string>();
  for (const [id, names] of Object.entries(registry.entities[type] ?? {})) for (const name of names) known.set(normalizeName(name), id);
  const records = new Map<string, ResolvedRecord>();
  for (const mention of mentions) {
    const key = normalizeName(mention.name);
    if (!key || owner.has(key)) continue;
    const id = known.get(key) ?? recordId(mention.name);
    const record = records.get(id) ?? { id, names: [], mentions: [] };
    if (!record.names.includes(mention.name.trim())) record.names.push(mention.name.trim());
    record.mentions.push(mention);
    records.set(id, record);
  }
  return [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
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

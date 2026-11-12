/**
 * @file src/entities/identity.ts
 * @description Which extracted names are the same record. Wrong merges are
 * worse than duplicates, so nothing here guesses:
 *
 *  - Extraction answers WHO each mention is (`name`, the fullest correct name the
 *    source supports, or a relation such as "Sam's mother") separately from how
 *    the source writes it (`writtenAs`: "Tommmy", "mama"). Records are grouped by
 *    `name`, and the registry, `exclude` and the owner check all match `name`;
 *    the spellings become the page's aliases and feed the possible-duplicate
 *    flags, but never merge or exclude anything.
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
 *  - The owner page has an id of its own that no record takes.
 *  - Records that MIGHT be the same (one name is another's first name, or two
 *    share a first name) are flagged both ways for the owner to settle in the
 *    registry, never merged.
 */

import { slugify } from "../utils/markdown.js";
import { cleanSpelling, type ExtractedRecord } from "./extract.js";

/** The owner's alias registry. */
export interface AliasRegistry {
  owner?: { type: string; names: string[] };
  /** Entity type → record id → the names that are that record. */
  entities: Record<string, Record<string, string[]>>;
  /** Entity type → names that are not records of that type. */
  exclude?: Record<string, string[]>;
  /** Entity type → sets of record ids the owner settled as different people, never flagged as possibly the same. */
  distinct?: Record<string, string[][]>;
}

/** One record as one source names it: an extracted record and the file it came from. */
export interface Mention extends ExtractedRecord {
  file: string;
}

/** One record after identity: its id, every name it went by, how the sources wrote it, and every mention. */
export interface ResolvedRecord {
  id: string;
  names: string[];
  /** Spellings the sources used that are not among `names`. */
  writtenAs: string[];
  mentions: Mention[];
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
/** Longest record id; a longer one is cut and given a hash so it stays unique and fits a filename. */
const MAX_ID_LENGTH = 80;

/** What a malformed `owner` is told it must be. */
const OWNER_SHAPE = '"owner" must be { "type": …, "names": [ … ] }';

/**
 * Read the registry text, or an empty registry when there is none. Malformed
 * JSON, any part of the wrong shape (an owner without a type and a list of
 * names, a record id that is not a slug, a map that is not of lists), or a name
 * both excluded and registered throws, so a mistake is never silently ignored.
 */
export function parseRegistry(text: string | null): AliasRegistry {
  if (text === null) return { entities: {} };
  const raw = JSON.parse(text) as Record<string, unknown>;
  const owner = parseOwner(raw.owner);
  const entities = Object.fromEntries(Object.entries(mapOf(raw.entities, '"entities" must map each entity type to its records'))
    .map(([type, records]) => [type, listsByKey(records, `"entities.${type}" must map each record id to a list of names`)]));
  for (const [type, records] of Object.entries(entities)) {
    const bad = Object.keys(records).find((id) => !SLUG.test(id));
    if (bad !== undefined) throw new Error(`"entities.${type}" record id "${bad}" is not a slug (lowercase letters, digits and hyphens)`);
  }
  const exclude = listsByKey(raw.exclude, '"exclude" must map each entity type to a list of names');
  assertNotBoth(entities, exclude);
  const distinct = parseDistinct(raw.distinct);
  return {
    ...(owner ? { owner } : {}), entities,
    ...(Object.keys(exclude).length > 0 ? { exclude } : {}), ...(Object.keys(distinct).length > 0 ? { distinct } : {}),
  };
}

/** The owner, or undefined when there is none; an owner without a type and a list of names throws. */
function parseOwner(value: unknown): AliasRegistry["owner"] {
  if (value === undefined) return undefined;
  const owner = mapOf(value, OWNER_SHAPE);
  if (typeof owner.type !== "string" || !Array.isArray(owner.names)) throw new Error(OWNER_SHAPE);
  return { type: owner.type, names: strings(owner.names) };
}

/** `value` as an object (`{}` when absent); anything else throws `message`. */
function mapOf(value: unknown, message: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

/** `value` as key → list of strings (`{}` when absent); a value that is not a list throws `message`. */
function listsByKey(value: unknown, message: string): Record<string, string[]> {
  const map = mapOf(value, message);
  if (!Object.values(map).every(Array.isArray)) throw new Error(message);
  return Object.fromEntries(Object.entries(map).map(([key, names]) => [key, strings(names)]));
}

/** `distinct` as type → sets of record ids; anything but a map of lists of two or more slug ids throws. */
function parseDistinct(value: unknown): Record<string, string[][]> {
  const message = '"distinct" must map each entity type to a list of sets, each two or more record ids';
  const map = mapOf(value, message);
  const isIdSet = (set: unknown): boolean => Array.isArray(set) && set.length >= 2 && set.every((id) => typeof id === "string" && SLUG.test(id));
  if (!Object.values(map).every((sets) => Array.isArray(sets) && sets.every(isIdSet))) throw new Error(message);
  return map as Record<string, string[][]>;
}

/** The strings in a list, ignoring anything else. */
function strings(value: unknown): string[] {
  return (value as unknown[]).filter((item): item is string => typeof item === "string");
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

/** A name with its accents removed ("Núñez" → "Nunez"). */
function withoutAccents(name: string): string {
  return name.normalize("NFKD").replace(/\p{M}/gu, "");
}

/** A name compared without case, accents, punctuation or extra spacing. */
function normalizeName(name: string): string {
  return withoutAccents(name).toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
}

/** A slug-safe id for a name: ASCII-folded and at most {@link MAX_ID_LENGTH} long, or a short hash when nothing slug-safe is left. */
export function recordId(name: string): string {
  const folded = slugify(withoutAccents(name)).replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");
  if (!SLUG.test(folded)) return `record-${nameHash(name)}`;
  return folded.length <= MAX_ID_LENGTH ? folded : `${folded.slice(0, MAX_ID_LENGTH - 8).replace(/-+$/, "")}-${nameHash(name)}`;
}

/** A short, stable hash of a name. */
function nameHash(name: string): string {
  let hash = 0;
  for (const char of normalizeName(name)) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash.toString(36);
}

/** The id of the owner page in `type`, or null when the owner is not of that type. */
export function ownerPageId(registry: AliasRegistry, type: string): string | null {
  const name = registry.owner?.type === type ? registry.owner.names[0] : undefined;
  if (!name) return null;
  const taken = new Set(Object.keys(registry.entities[type] ?? {}));
  const base = recordId(name);
  return taken.has(base) ? uniqueId(`${base}-owner`, taken) : base;
}

/**
 * Group one type's mentions into records: registry names first, then exact
 * normalized names. Each record gets its own id: a registry id as given, else
 * its name's slug, with a numbered suffix when another record or the owner page has it.
 */
export function resolveRecords(type: string, mentions: Mention[], registry: AliasRegistry): ResolvedRecord[] {
  const taken = new Set(Object.keys(registry.entities[type] ?? {}));
  const ownerPage = ownerPageId(registry, type);
  if (ownerPage) taken.add(ownerPage);
  // Excluded names still take their ids here, so excluding one never renames another record.
  return [...groupMentions(type, mentions, registry)].sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => ({ group, id: group.registered ?? uniqueId(recordId(group.names[0]), taken) }))
    .filter(({ group }) => !group.excluded)
    .map(({ group, id }) => ({ id, names: group.names, writtenAs: spellingsOf(group), mentions: group.mentions }))
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

/** Words that refer to someone without naming them; a spelling made only of these is no name. */
const PRONOUNS = new Set(["i", "me", "my", "you", "your", "he", "him", "his", "she", "her", "hers", "it", "its", "we", "us", "our", "they", "them", "their", "the", "a"]);
/**
 * Words a spelling can start with that name a relation, not a person: possessive
 * pronouns ("my dad") and family words ("mom", "mother-in-law"). A spelling that
 * starts with one never makes a "Might be the same as" flag. (A given name that is
 * also a family word, like "Son", is not indexed either; its full name still is.)
 */
const RELATION_WORDS = new Set([
  "my", "your", "his", "her", "our", "their",
  "mom", "mum", "mama", "momma", "mommy", "mother", "dad", "papa", "father", "parent", "parents", "brother", "brothers", "sister", "sisters",
  "aunt", "auntie", "aunts", "uncle", "uncles", "cousin", "niece", "nephew", "wife", "husband", "partner", "son", "daughter", "kid", "child", "baby",
  "grandma", "grandmother", "grandpa", "grandfather", "gran", "granny", "nan",
]);

/** A name formed as a relation to someone ("Sam's mother"). */
const RELATION_NAME = /\S['’]s\s/;

/** Whether a normalized first word names a relation: one of {@link RELATION_WORDS}, an in-law, or a step-relation. */
function isRelationWord(word: string): boolean {
  return RELATION_WORDS.has(word) || word.endsWith("-in-law") || (word.startsWith("step") && RELATION_WORDS.has(word.slice("step".length)));
}

/** Whether a spelling is only pronouns and articles ("they", "his"), which the model sometimes lists among how a source writes someone. */
function isPronoun(form: string): boolean {
  return normalizeName(form).split(" ").every((word) => PRONOUNS.has(word));
}

/** The spellings a group's mentions used that are not among its names, leaving out bare pronouns. */
function spellingsOf(group: MentionGroup): string[] {
  const names = new Set(group.names.map(normalizeName));
  const first = new Map<string, string>();
  for (const form of group.mentions.flatMap((mention) => mention.writtenAs ?? []).map(cleanSpelling)) {
    const key = normalizeName(form);
    if (key && !names.has(key) && !isPronoun(form) && !first.has(key)) first.set(key, form);
  }
  return [...first.values()];
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

/**
 * Record id → ids of records that might be the same one: a name or spelling of
 * one is another's first name, or two share a first name. A relation name ("Sam's
 * mother") and a spelling that starts with a possessive pronoun or family word
 * ("my dad", "mom") are not indexed by their first word, which names no one. Ids in one of the
 * `distinct` sets were settled as different people and are never flagged together.
 */
export function possibleDuplicates(records: ResolvedRecord[], distinct: string[][] = []): Map<string, string[]> {
  const settled = (a: string, b: string): boolean => distinct.some((set) => set.includes(a) && set.includes(b));
  const others = new Map<string, Set<string>>();
  for (const ids of firstNameIndex(records).values()) {
    for (const id of ids) for (const other of ids) if (other !== id && !settled(id, other)) others.set(id, (others.get(id) ?? new Set()).add(other));
  }
  return new Map([...others].map(([id, ids]) => [id, [...ids].sort()]));
}

/** First word → ids of the records with a name or spelling starting with it; relation names and words that name no one are left out. */
function firstNameIndex(records: ResolvedRecord[]): Map<string, Set<string>> {
  const firstNames = new Map<string, Set<string>>();
  for (const record of records) {
    for (const name of [...record.names, ...record.writtenAs].filter((candidate) => !RELATION_NAME.test(candidate))) {
      const first = normalizeName(name).split(" ")[0];
      if (first && !isRelationWord(first)) firstNames.set(first, (firstNames.get(first) ?? new Set()).add(record.id));
    }
  }
  return firstNames;
}

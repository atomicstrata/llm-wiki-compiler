/**
 * @file src/scale/downgrade-schema.ts
 * @description STRICT, CLOSED validation of everything a scale-down reads
 * back as data: a plan's inventory, and the journal leaves a resume adopts
 * identities from (stage manifest, archive leaf, receipt).
 *
 * Every object must have exactly its keys (optional ones named), every
 * string and list is bounded, every digest is lowercase SHA-256 hex, every
 * count a non-negative safe integer, every enum one of its values. Paths are
 * not free text: each unit's path must be the fixed incumbent path of its
 * kind (a catalog's is derived from its workspace), and the prior paths must
 * be exactly the units' paths plus the JSON embedding store (none without
 * units). A violation
 * throws {@link SchemaViolation}; callers turn it into their own typed
 * refusal. Nothing is repaired or defaulted.
 */

import { legacyCatalogPath } from "../history/operation-catalog.js";
import { CAPABILITIES_V3 } from "./contracts-v2.js";
import { EMBEDDINGS_BINARY_FILE, EVENTS_FILE, RELATIONS_FILE, STATE_FILE } from "../utils/constants.js";
import { MAX_DOWNGRADE_WORKSPACES, type DowngradeUnitV1 } from "./downgrade-contracts.js";

/** Longest free-text field kept. */
const MAX_TEXT = 4096;
/** Most stores, runs and pins a plan lists. */
const MAX_LIST = 10_000;

/** A violated schema. */
export class SchemaViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaViolation";
  }
}

type Fields = Record<string, unknown>;

/** Refuse with `message`. */
function violate(message: string): never {
  throw new SchemaViolation(message);
}

/** `value` as an object with exactly `required` keys plus any of `optional`. */
export function closed(value: unknown, what: string, required: readonly string[], optional: readonly string[] = []): Fields {
  if (value === null || typeof value !== "object" || Array.isArray(value)) violate(`${what} must be an object`);
  const keys = Object.keys(value);
  if (!required.every((key) => keys.includes(key)) || !keys.every((key) => required.includes(key) || optional.includes(key))) violate(`${what} has unexpected or missing fields`);
  return value as Fields;
}

/** Refuse unless `value` is a non-negative safe integer. */
export function count(value: unknown, what: string): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : violate(`${what} must be a count`);
}

/** Refuse unless `value` is a bounded string. */
export function text(value: unknown, what: string, max = MAX_TEXT): string {
  return typeof value === "string" && value.length <= max ? value : violate(`${what} must be a bounded string`);
}

/** Refuse unless `value` is a SHA-256 digest (or null when `nullable`, or empty when `emptyOk`). */
export function digest(value: unknown, what: string, nullable = false, emptyOk = false): string | null {
  if (nullable && value === null) return null;
  if (emptyOk && value === "") return "";
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : violate(`${what} must be a SHA-256 digest`);
}

/** Refuse unless `value` is one of `allowed`. */
function oneOf<T extends string>(value: unknown, what: string, allowed: readonly T[]): T {
  return allowed.includes(value as T) ? (value as T) : violate(`${what} must be one of ${allowed.join(", ")}`);
}

/** Refuse unless `value` is a list of at most `max` items, each checked by `item`. */
export function list<T>(value: unknown, what: string, max: number, item: (entry: unknown, at: number) => T): T[] {
  if (!Array.isArray(value) || value.length > max) violate(`${what} must be a list of at most ${max}`);
  return value.map(item);
}

/** Refuse unless `value` is an object identity (decimal strings). */
export function identity(value: unknown, what: string, nullable = false): unknown {
  if (nullable && value === null) return null;
  const fields = closed(value, what, ["kind", "dev", "ino", "size", "mtimeNs"]);
  oneOf(fields.kind, `${what}.kind`, ["file", "directory", "other"]);
  for (const key of ["dev", "ino", "size", "mtimeNs"]) if (typeof fields[key] !== "string" || !/^\d{1,40}$/.test(fields[key] as string)) violate(`${what}.${key} must be a decimal string`);
  return value;
}

/** The fixed incumbent path of a unit of `kind` in canonical `root`. */
function unitPath(root: string, kind: DowngradeUnitV1["kind"], workspaceId: string | undefined): string {
  if (kind === "catalog") {
    // An invalid workspace id is a malformed plan, never an untyped error.
    try { return legacyCatalogPath(root, workspaceId ?? violate("a catalog unit names no workspace")); } catch (error) {
      return error instanceof SchemaViolation ? violate(error.message) : violate("a catalog unit names an invalid workspace");
    }
  }
  return kind === "events" ? EVENTS_FILE : kind === "relations" ? RELATIONS_FILE : kind === "state" ? STATE_FILE : EMBEDDINGS_BINARY_FILE;
}

/** One export unit of canonical `root`, its path the fixed one of its kind. `extra` names more required keys. */
function unit(root: string, value: unknown, what: string, extra: readonly string[] = []): DowngradeUnitV1 {
  const fields = closed(value, what, ["kind", "relPath", "present", "bytes", "sha256", "records", ...extra], ["workspaceId", "headDigest"]);
  const kind = oneOf(fields.kind, `${what}.kind`, ["events", "relations", "catalog", "state", "vectors"] as const);
  const workspaceId = fields.workspaceId === undefined ? undefined : text(fields.workspaceId, `${what}.workspaceId`, 256);
  if (fields.relPath !== unitPath(root, kind, workspaceId)) violate(`${what}.relPath is not the incumbent path of its kind`);
  if (typeof fields.present !== "boolean") violate(`${what}.present must be a boolean`);
  count(fields.bytes, `${what}.bytes`);
  count(fields.records, `${what}.records`);
  digest(fields.sha256, `${what}.sha256`, true);
  if (fields.headDigest !== undefined) digest(fields.headDigest, `${what}.headDigest`, true);
  return value as DowngradeUnitV1;
}

/** Refuse unless `paths` are exactly the units' paths plus the JSON embedding store, in order. */
function assertPriorPaths(paths: readonly string[], units: readonly DowngradeUnitV1[]): void {
  // A scale-down without exports (from local-large) replaces no file.
  const expected = units.length === 0 ? [] : [...new Set([...units.map((entry) => entry.relPath), ".llmwiki/embeddings.json"])];
  if (JSON.stringify(paths) !== JSON.stringify(expected)) violate("the prior files are not exactly the units' paths and the JSON embedding store");
}

/** The units list of a plan or journal. */
export function units(root: string, value: unknown, what: string, extra: readonly string[] = []): DowngradeUnitV1[] {
  return list(value, what, MAX_DOWNGRADE_WORKSPACES + 4, (entry, at) => unit(root, entry, `${what}[${at}]`, extra));
}

/** The requested estimate. */
function requested(value: unknown): void {
  const fields = closed(value, "requested", ["sizeBytes", "documents", "sizeBasis", "documentsBasis"]);
  if (count(fields.sizeBytes, "requested.sizeBytes") === 0 || count(fields.documents, "requested.documents") === 0) violate("requested figures must be positive");
  oneOf(fields.sizeBasis, "requested.sizeBasis", ["stated", "derived"]);
  oneOf(fields.documentsBasis, "requested.documentsBasis", ["stated", "derived"]);
}

/** The bound measurements and digests of an inventory. */
function measuredParts(fields: Fields): void {
  const record = closed(fields.record, "record", ["revision", "sha256"]);
  count(record.revision, "record.revision");
  digest(record.sha256, "record.sha256", false, true);
  const measured = closed(fields.measured, "measured", ["sourceDocuments", "sourceBytes", "wikiFiles", "wikiBytes"]);
  for (const key of Object.keys(measured)) count(measured[key], `measured.${key}`);
  const freeze = closed(fields.freeze, "freeze", ["entries", "bytes", "digest"]);
  count(freeze.entries, "freeze.entries");
  count(freeze.bytes, "freeze.bytes");
  digest(freeze.digest, "freeze.digest", false, true);
}

/** The indexed facts of an inventory. */
function indexedParts(fields: Fields): void {
  list(fields.stores, "stores", MAX_LIST, (entry, at) => { const store = closed(entry, `stores[${at}]`, ["name", "manifestSha256"]); text(store.name, "store name", 64); digest(store.manifestSha256, "store manifest"); });
  list(fields.runs, "runs", MAX_LIST, (entry, at) => { const run = closed(entry, `runs[${at}]`, ["runId", "status"]); text(run.runId, "run id", 64); text(run.status, "run status", 64); });
  if (fields.lastRun !== null) text(fields.lastRun, "lastRun", 64);
  const pins = closed(fields.pins, "pins", ["labels", "digest"]);
  list(pins.labels, "pins.labels", MAX_LIST, (label) => text(label, "pin label", 64));
  text(pins.digest, "pins.digest", 64);
  list(fields.capabilities, "capabilities", CAPABILITIES_V3.length, (name) => oneOf(name, "capability", CAPABILITIES_V3));
}

/** The prior files, notices and blockers of an inventory (units already checked). */
function outcomeParts(fields: Fields, checkedUnits: readonly DowngradeUnitV1[]): void {
  const priors = list(fields.priors, "priors", MAX_DOWNGRADE_WORKSPACES + 5, (entry, at) => {
    const prior = closed(entry, `priors[${at}]`, ["relPath", "sha256", "bytes"]);
    digest(prior.sha256, "prior sha256", true);
    count(prior.bytes, "prior bytes");
    return text(prior.relPath, "prior path", 1024);
  });
  assertPriorPaths(priors, checkedUnits);
  list(fields.notices, "notices", 32, (notice) => text(notice, "notice", 64));
  list(fields.blockers, "blockers", MAX_LIST, (entry, at) => { const blocker = closed(entry, `blockers[${at}]`, ["code", "detail"]); text(blocker.code, "blocker code", 64); text(blocker.detail, "blocker detail"); });
}

/**
 * An evidence directory's name: `<fence revision>-<12 hex digits of the plan
 * digest>`. The inventory binds ONLY names matching this, so a ready plan's
 * `cancelled` list always parses here.
 */
export const EVIDENCE_DIR_NAME = /^[1-9]\d{0,15}-[0-9a-f]{12}$/u;
/** Most completed-cancel evidence directories a plan binds (the inventory's own listing bound). */
const MAX_CANCELLED = 1_000;

/** The optional `cancelled` list: absent, or a non-empty, strictly ascending list of evidence directory names, only from local-indexed. */
function cancelledPart(fields: Fields): void {
  if (fields.cancelled === undefined) return;
  if (fields.from !== "local-indexed") violate("only a scale-down from local-indexed binds cancelled evidence");
  const names = list(fields.cancelled, "cancelled", MAX_CANCELLED, (name) => (typeof name === "string" && EVIDENCE_DIR_NAME.test(name) ? name : violate("cancelled must name evidence directories")));
  if (names.length === 0 || names.some((name, at) => at > 0 && !(names[at - 1]! < name))) violate("cancelled must be a non-empty, strictly ascending list");
}

/** Validate a plan's inventory for canonical `root`. */
export function validateInventory(root: string, value: unknown): void {
  const keys = ["from", "target", "record", "requested", "measured", "freeze", "stores", "units", "priors", "runs", "lastRun", "pins", "capabilities", "notices", "blockers"];
  const fields = closed(value, "inventory", keys, ["cancelled"]);
  cancelledPart(fields);
  oneOf(fields.from, "from", ["local-standard", "local-large", "local-indexed"]);
  oneOf(fields.target, "target", ["local-standard", "local-large"]);
  requested(fields.requested);
  measuredParts(fields);
  indexedParts(fields);
  const checked = units(root, fields.units, "units");
  outcomeParts(fields, checked);
  // Only an indexed scale-down exports and replaces files.
  if (fields.from !== "local-indexed" && checked.length > 0) violate("only a scale-down from local-indexed exports units");
}

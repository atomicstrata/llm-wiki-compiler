/**
 * @file src/portable/federation/validate.ts
 * @description The shape and bound checks of every federation request (slice
 * S6), applied identically by the SDK before it sends and by the host before
 * any work: closed method and entry unions, safe integers, bounded strings,
 * paths, tokens, credential and child counts.
 *
 * An overview child must be exactly one leaf concept page,
 * `wiki/concepts/<leaf>.md`; an overview as a child is `not_one_level`; a
 * duplicate is invalid. Too many children, links or entries is
 * `limit_exceeded`. Nothing here reads a project: a malformed request costs
 * the host nothing but this check.
 */

import { FEDERATION_LIMITS, type FederationLimits, type FederationRefusalCodeV2 } from "./contracts.js";

/** Every method of the protocol. */
const FEDERATION_METHODS = [
  "search", "links", "quality",
  "overview.propose", "overview.list", "overview.get", "overview.approve", "overview.approval", "overview.apply", "overview.read",
  "queue", "group",
] as const;
export type FederationMethod = (typeof FEDERATION_METHODS)[number];

/** An overview slug. */
const OVERVIEW_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/u;
/** A leaf concept page path: one safe segment, nothing nested. */
const LEAF_PAGE = /^wiki\/concepts\/[a-z0-9][a-z0-9-]{0,127}\.md$/u;
/** A page id as listings and links name it. */
const PAGE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/u;

type Body = Record<string, unknown>;
type Verdict = FederationRefusalCodeV2 | null;

/** True when `value` is a string within `max` UTF-8 bytes. */
function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max;
}

/** True when `value` is a string matching `pattern` — never a coerced value. */
function isMatch(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

/** True when `value` is a safe integer in `[min, max]`. */
function isCount(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** The verdict on the credentials and federation id every request carries. */
function scopeVerdict(body: Body, limits: FederationLimits, needsShards: boolean): Verdict {
  if (!isText(body.federationId, limits.maxStringBytes)) return "invalid_request";
  if (!needsShards && body.shards === undefined) return null;
  if (!Array.isArray(body.shards)) return "invalid_request";
  if (body.shards.length > limits.maxCredentials) return "limit_exceeded";
  const isCredential = (entry: unknown): boolean => entry !== null && typeof entry === "object"
    && isText((entry as Body).project, limits.maxStringBytes) && isText((entry as Body).token, limits.maxTokenChars);
  const projects = body.shards.map((entry) => (entry as Body)?.project);
  return body.shards.every(isCredential) && new Set(projects).size === projects.length ? null : "invalid_request";
}

/** The verdict on one overview child. */
function childVerdict(child: Body, limits: FederationLimits): Verdict {
  if (child === null || typeof child !== "object" || !isText(child.project, limits.maxStringBytes) || !isText(child.path, limits.maxPathBytes)) return "invalid_request";
  if ((child.path as string).startsWith("wiki/overviews/")) return "not_one_level";
  return isMatch(child.path, LEAF_PAGE) ? null : "invalid_request";
}

/** The verdict on an overview's explicit children: bounded, each a leaf page, no duplicate. */
function childrenVerdict(children: unknown, limits: FederationLimits): Verdict {
  if (!Array.isArray(children) || children.length === 0) return "invalid_request";
  if (children.length > limits.maxChildren) return "limit_exceeded";
  for (const child of children as Body[]) {
    const verdict = childVerdict(child, limits);
    if (verdict !== null) return verdict;
  }
  const keys = (children as Body[]).map((child) => `${child.project as string}\u0000${child.path as string}`);
  return new Set(keys).size === keys.length ? null : "invalid_request";
}

/** True when one grouped entry is a well-formed member of the closed union. */
function isGroupEntry(entry: Body, limits: FederationLimits): boolean {
  if (entry === null || typeof entry !== "object" || !isText(entry.project, limits.maxStringBytes) || !isText(entry.operationId, limits.maxStringBytes)) return false;
  if (entry.kind === "source.add") return isText(entry.name, limits.maxStringBytes) && typeof entry.text === "string" && Buffer.byteLength(entry.text) <= limits.maxRequestBytes;
  return entry.kind === "scoped.apply" && isText(entry.approvalId, limits.maxStringBytes);
}

/** The verdict on a grouped request's entries. */
function groupVerdict(entries: unknown, limits: FederationLimits): Verdict {
  if (!Array.isArray(entries) || entries.length === 0) return "invalid_request";
  if (entries.length > limits.maxGroupEntries) return "limit_exceeded";
  return (entries as Body[]).every((entry) => isGroupEntry(entry, limits)) ? null : "invalid_request";
}

/** `invalid_request` unless every named field is bounded text. */
function textFields(body: Body, limits: FederationLimits, ...names: string[]): Verdict {
  return names.every((name) => isText(body[name], limits.maxStringBytes)) ? null : "invalid_request";
}

/** The verdict on a links request's source. */
function linksVerdict(body: Body, limits: FederationLimits): Verdict {
  const source = body.source as Body | null;
  return source !== null && typeof source === "object" && isText(source.shard, limits.maxStringBytes) && isMatch(source.id, PAGE_ID) ? null : "invalid_request";
}

/** The verdict on a propose request. */
function proposeVerdict(body: Body, limits: FederationLimits): Verdict {
  return textFields(body, limits, "operationId", "title") ?? (isMatch(body.slug, OVERVIEW_SLUG) ? childrenVerdict(body.children, limits) : "invalid_request");
}

/** The verdict on a queue request. */
function queueVerdict(body: Body, limits: FederationLimits): Verdict {
  if (body.cursor !== undefined && !isText(body.cursor, limits.maxPathBytes)) return "invalid_request";
  return body.limit === undefined || isCount(body.limit, 1, limits.maxQueuePage) ? null : "invalid_request";
}

/** Each method's own check. */
const METHOD_VERDICTS: Record<FederationMethod, (body: Body, limits: FederationLimits) => Verdict> = {
  "search": (body, limits) => textFields(body, limits, "text") ?? (body.limit === undefined || isCount(body.limit, 1, limits.maxHits) ? null : "invalid_request"),
  "links": linksVerdict,
  "quality": () => null,
  "overview.propose": proposeVerdict,
  "overview.list": (body, limits) => textFields(body, limits, "proposalOperationId"),
  "overview.get": (body, limits) => textFields(body, limits, "proposalOperationId", "candidateId"),
  "overview.approval": (body, limits) => textFields(body, limits, "approvalId"),
  "overview.approve": (body, limits) => textFields(body, limits, "operationId", "proposalOperationId", "candidateSetDigest", "planDigest", "applyDependenciesDigest", "requestedExpiresAt"),
  "overview.apply": (body, limits) => textFields(body, limits, "operationId", "approvalId"),
  "overview.read": (body) => (isMatch(body.slug, OVERVIEW_SLUG) ? null : "invalid_request"),
  "queue": queueVerdict,
  "group": (body, limits) => groupVerdict(body.entries, limits),
};

/**
 * The refusal a request earns before any work, or `null` when its shape and
 * bounds are admitted. The queue alone needs no shard credentials.
 */
export function requestVerdict(method: FederationMethod, body: unknown, limits: FederationLimits = FEDERATION_LIMITS): Verdict {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "invalid_request";
  const size = encodedSize(body);
  if (size === null) return "invalid_request";
  if (size > limits.maxRequestBytes) return "limit_exceeded";
  return scopeVerdict(body as Body, limits, method !== "queue") ?? METHOD_VERDICTS[method](body as Body, limits);
}

/** The request's encoded size, as the wire would carry it; `null` when it has no JSON form. */
function encodedSize(body: object): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(body));
  } catch {
    return null;
  }
}

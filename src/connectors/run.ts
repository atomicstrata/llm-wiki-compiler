/**
 * @file src/connectors/run.ts
 * @description Connector substrate: activation, fetch, provenance, idempotency, and staging.
 *
 * Profiles contain only pure connector bindings. This module is the host-owned
 * execution boundary: it checks the operator activation env var, loads
 * tighten-only project config, performs the host-mediated fetch, maps exactly one
 * connector draft into a typed staged entity page, and appends an audit event.
 * Candidate-store mutations run under the project lock so supersede and review
 * approval cannot interleave on the same pending candidate.
 */

import packageJson from "../../package.json";
import { buildFrontmatter } from "../utils/markdown.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import { stageEntityPage } from "../trust/staging.js";
import { archiveCandidate, listCandidates, restoreArchivedCandidate } from "../compiler/candidates.js";
import { appendEventLocked, preflightEventAppend } from "../events/store.js";
import { acquireLock, releaseLock } from "../utils/lock.js";
import { getConnectorDef } from "./registry.js";
import {
  appendConnectorEvent,
  connectorEvent,
  MAX_CONNECTOR_INPUT_BYTES,
  preflightAuditCapacity,
  type SupersedableCandidates,
} from "./audit.js";
import { sha256Text } from "./hash.js";
import { confinedFetch, validateConnectorHeaders, type ConfinedFetchResult, type FetchLimits } from "./confined-fetch.js";
import { isConnectorActivated, loadConnectorConfig, type ConnectorRuntimeConfig } from "./config.js";
import { CONNECTOR_BLOCK_KEY } from "./fence.js";
import { connectorBlockFromBody } from "./origin.js";
import { enforceRequestInterval } from "./rate-limit.js";
import type { ConnectorBindingDef, ConnectorProvenance, ConnectorRequest, DurableConnectorBlock } from "./types.js";
import type { LoadedProfile, ProfilePack } from "../profile/types.js";
import type { StagedChange } from "../trust/staged-change.js";
import type { ReviewCandidate } from "../utils/types.js";

const PACKAGE_VERSION = packageJson.version;

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_FETCH_MAX_BYTES = 1_000_000;
const DEFAULT_FETCH_REDIRECTS = 3;
const DEFAULT_FETCH_CONTENT_TYPES = ["application/json", "text/plain"] as const;
const PREFLIGHT_CANDIDATE_SUFFIX = "f".repeat(64);

/** Outcome of one host-mediated connector run. */
export type RunConnectorResult =
  | { kind: "staged"; candidateIds: string[] }
  | { kind: "noop"; candidateIds: string[] }
  | { kind: "superseded"; archivedIds: string[]; candidateIds: string[] }
  | { kind: "refused"; reason: string }
  | { kind: "unavailable"; reason: string };

/** Test seams for deterministic offline connector runs. */
export interface RunConnectorDeps {
  fetcher?: (request: ConnectorRequest, limits: FetchLimits, allowedHosts: readonly string[]) => Promise<ConfinedFetchResult>;
  now?: () => Date;
}

interface PreparedDraft {
  entityType: string;
  slug: string;
  body: string;
  provenance: ConnectorProvenance;
  idempotencyKey: string;
  contentHash: string;
  draftContentHash: string;
  finalUrl: string;
}

type ConnectorConfigResult = { kind: "ok"; config: ConnectorRuntimeConfig } | RunConnectorResult;

/** Run one activated connector and stage its mapped draft as a typed review candidate. */
export async function runConnector(
  root: string,
  connectorId: string,
  inputs: Record<string, string>,
  deps: RunConnectorDeps = {},
): Promise<RunConnectorResult> {
  const prepared = await prepareConnectorDraft(root, connectorId, inputs, deps);
  if ("kind" in prepared) return prepared;
  if (!(await acquireLock(root, { quiet: true }))) {
    return { kind: "unavailable", reason: "connector candidate store locked" };
  }
  try {
    return await stagePreparedDraft(root, prepared, deps.now);
  } finally {
    await releaseLock(root);
  }
}

/** The pre-fetch gate outcome: everything the fetch and compose phases need. */
interface GatedConnectorRun {
  context: Awaited<Exclude<Awaited<ReturnType<typeof loadConnectorProfile>>, RunConnectorResult>>;
  request: ConnectorRequest;
  allowedHosts: readonly string[];
}

/** Resolve profile/binding/config, fetch external bytes, parse one draft, and compose the candidate body. */
async function prepareConnectorDraft(
  root: string,
  connectorId: string,
  inputs: Record<string, string>,
  deps: RunConnectorDeps,
): Promise<PreparedDraft | RunConnectorResult> {
  const gated = await gateConnectorRun(root, connectorId, inputs, deps.now);
  if ("kind" in gated) return gated;
  const fetched = await (deps.fetcher ?? confinedFetch)(gated.request, fetchLimitsFor(gated.request), gated.allowedHosts);
  if (fetched.kind !== "ok") return fetched;
  return composePreparedDraft(gated.context, inputs, fetched, deps.now);
}

/** Every pre-fetch gate: profile binding, input contract, config floors, headers, audit capacity, rate interval. */
async function gateConnectorRun(
  root: string,
  connectorId: string,
  inputs: Record<string, string>,
  now?: () => Date,
): Promise<GatedConnectorRun | RunConnectorResult> {
  const context = await loadConnectorProfile(root, connectorId);
  if ("kind" in context) return context;
  const inputCheck = validateConnectorInputs(context.def.inputs, inputs);
  if (inputCheck) return inputCheck;
  const config = await loadRunnableConnectorConfig(root, connectorId, context.def);
  if (config.kind !== "ok") return config;
  const request = buildConnectorRequest(context.def.buildRequest(inputs), config.config.contactEmail);
  const headers = validateConnectorHeaders(request.headers ?? {});
  if (headers.kind !== "ok") return headers;
  const supersedable = await supersedableCandidates(root, context.def.id, context.def.canonicalSourceId(inputs));
  const audit = await preflightAuditCapacity(root, context.def, supersedable, now);
  if (audit) return audit;
  const interval = await enforceRequestInterval(root, connectorId, config.config, now);
  if (interval) return interval;
  return { context, request, allowedHosts: config.config.allowedHosts };
}

/**
 * Enforce the connector's declared input contract before dialing the network.
 *
 * Values are runtime-checked (not just TypeScript-typed) because a JS/SDK
 * caller can pass any shape; a non-string or oversized value must never reach
 * the rate stamp, the fetch, or the host slug.
 */
function validateConnectorInputs(required: readonly string[], inputs: Record<string, string>): RunConnectorResult | null {
  const requiredSet = new Set(required);
  for (const [key, value] of Object.entries(inputs)) {
    if (!requiredSet.has(key)) return { kind: "refused", reason: `unknown connector input: ${key}` };
    if (typeof value !== "string") return { kind: "refused", reason: `connector input ${key} must be a string` };
    if (value.length === 0) return { kind: "refused", reason: `connector input ${key} is empty` };
    if (Buffer.byteLength(value, "utf8") > MAX_CONNECTOR_INPUT_BYTES) {
      return { kind: "refused", reason: `connector input ${key} exceeds ${MAX_CONNECTOR_INPUT_BYTES} bytes` };
    }
  }
  for (const key of required) {
    if (inputs[key] === undefined) return { kind: "refused", reason: `missing connector input: ${key}` };
  }
  return null;
}

/** Load runtime connector config and enforce activation/contact floors before any network request. */
async function loadRunnableConnectorConfig(
  root: string,
  connectorId: string,
  def: NonNullable<ReturnType<typeof getConnectorDef>>,
): Promise<ConnectorConfigResult> {
  if (!isConnectorActivated(connectorId)) return { kind: "refused", reason: "connector is not activated" };
  const config = await loadConnectorConfig(root, connectorId, def.allowedHosts, def.minRequestIntervalMs ?? 0);
  if (config.kind === "unavailable") return { kind: "unavailable", reason: config.reason };
  if (def.requiresContactEmail && !config.config.contactEmail) {
    return { kind: "refused", reason: "connector requires contactEmail" };
  }
  return { kind: "ok", config: config.config };
}

/** Load the active non-default profile and its binding for `connectorId`. */
async function loadConnectorProfile(
  root: string,
  connectorId: string,
): Promise<{ loaded: LoadedProfile; profile: ProfilePack; binding: ConnectorBindingDef; def: NonNullable<ReturnType<typeof getConnectorDef>> } | RunConnectorResult> {
  const def = getConnectorDef(connectorId);
  if (!def) return { kind: "refused", reason: "unknown connector" };
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) return { kind: "refused", reason: "connectors require a non-default profile" };
  const binding = loaded.profile.connectors?.[connectorId];
  if (!binding) return { kind: "refused", reason: "profile does not bind connector" };
  return { loaded, profile: loaded.profile, binding, def };
}

/** Add the host-owned polite User-Agent when project config supplies a contact email. */
function buildConnectorRequest(request: ConnectorRequest, contactEmail?: string): ConnectorRequest {
  if (!contactEmail) return request;
  return {
    ...request,
    headers: {
      ...(request.headers ?? {}),
      "User-Agent": politeUserAgent(PACKAGE_VERSION, contactEmail),
    },
  };
}

/** Build bounded fetch limits from the connector request. */
function fetchLimitsFor(request: ConnectorRequest): FetchLimits {
  return {
    timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    maxBytes: DEFAULT_FETCH_MAX_BYTES,
    maxRedirects: DEFAULT_FETCH_REDIRECTS,
    contentTypes: request.contentTypes ?? DEFAULT_FETCH_CONTENT_TYPES,
  };
}

/** Compose the host-authored page body and provenance from a parsed connector draft. */
function composePreparedDraft(
  context: { profile: ProfilePack; binding: ConnectorBindingDef; def: NonNullable<ReturnType<typeof getConnectorDef>> },
  inputs: Record<string, string>,
  fetched: Extract<ConfinedFetchResult, { kind: "ok" }>,
  now?: () => Date,
): PreparedDraft | RunConnectorResult {
  const drafts = context.def.parse(fetched.bytes.toString("utf8"), inputs);
  if (drafts.length !== 1) return { kind: "refused", reason: "connector must return exactly one draft" };
  const draft = drafts[0]!;
  const canonicalSourceId = context.def.canonicalSourceId(inputs);
  const key = idempotencyKey(context.def.id, canonicalSourceId);
  const content = connectorBodyContent(context.binding, draft);
  if (typeof content !== "string") return content;
  const mapped = mapDraftFields(context.profile, context.binding, draft.fields);
  if ("kind" in mapped) return mapped;
  const block = durableConnectorBlock(context.def, fetched, key, mapped.externalFields, now);
  const body = composeBody(mapped.fields, content, block);
  const draftContentHash = sha256Text(body);
  return {
    entityType: context.binding.entityType,
    slug: hostSlug(context.def.id, canonicalSourceId),
    body,
    provenance: { ...block, draftContentHash },
    idempotencyKey: key,
    contentHash: fetched.contentHash,
    draftContentHash,
    finalUrl: fetched.finalUrl,
  };
}

/** Select the body prose from the configured contentField, or the connector's default content. */
function connectorBodyContent(
  binding: ConnectorBindingDef,
  draft: { fields: Record<string, unknown>; content: string },
): string | RunConnectorResult {
  if (!binding.contentField) return draft.content;
  const value = draft.fields[binding.contentField];
  if (typeof value !== "string") {
    return { kind: "refused", reason: `connector contentField ${binding.contentField} is not a string` };
  }
  return value;
}

/** Mechanically map connector-emitted draft fields into profile entity fields. */
function mapDraftFields(
  profile: ProfilePack,
  binding: ConnectorBindingDef,
  draftFields: Record<string, unknown>,
): { fields: Record<string, unknown>; externalFields: string[] } | RunConnectorResult {
  const entity = profile.entities[binding.entityType];
  if (!entity) return { kind: "refused", reason: "connector entity type is not declared" };
  const fields: Record<string, unknown> = {};
  const externalFields = Object.values(binding.fields);
  for (const [draftField, entityField] of Object.entries(binding.fields)) {
    if (!entity.fields?.[entityField]) return { kind: "refused", reason: "connector maps to undeclared field" };
    // Omit unset draft values explicitly (e.g. a work with no publication year)
    // instead of relying on the YAML serializer to skip undefined.
    if (draftFields[draftField] !== undefined) fields[entityField] = draftFields[draftField];
  }
  return { fields, externalFields };
}

/** Build the durable connector block written into frontmatter. */
function durableConnectorBlock(
  def: NonNullable<ReturnType<typeof getConnectorDef>>,
  fetched: Extract<ConfinedFetchResult, { kind: "ok" }>,
  key: string,
  externalFields: string[],
  now?: () => Date,
): DurableConnectorBlock {
  return {
    connectorId: def.id,
    connectorVersion: def.version,
    sourceUrl: fetched.finalUrl,
    fetchedAt: (now ? now() : new Date()).toISOString(),
    contentHash: fetched.contentHash,
    idempotencyKey: key,
    externalFields,
  };
}

/** Mutate the candidate store under the held project lock and append the audit event. */
async function stagePreparedDraft(
  root: string,
  draft: PreparedDraft,
  now?: () => Date,
): Promise<RunConnectorResult> {
  const existing = (await listCandidates(root)).filter((candidate) =>
    durableProvenance(candidate)?.idempotencyKey === draft.idempotencyKey);
  if (existing.some((candidate) => durableProvenance(candidate)?.contentHash === draft.contentHash)) {
    const candidateIds = existing.map((candidate) => candidate.id);
    const event = connectorEvent(draft, [], candidateIds, [], now);
    await preflightEventAppend(root, event);
    await appendEventLocked(root, event);
    return { kind: "noop", candidateIds };
  }
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) return { kind: "unavailable", reason: "connector profile unavailable" };
  const preflightIds = [preflightCandidateId(draft.slug)];
  const archivedIds = existing.map((candidate) => candidate.id);
  await preflightEventAppend(root, connectorEvent(draft, preflightIds, [], archivedIds, now));
  if (!(await archiveCandidatesWithUndo(root, existing))) {
    return { kind: "unavailable", reason: "connector could not archive a superseded candidate" };
  }
  const staged = await stageReplacementOrRestore(root, draft, loaded.profile, archivedIds, now);
  await appendConnectorEvent(root, draft, [staged.id], [], archivedIds, now);
  return archivedIds.length > 0
    ? { kind: "superseded", archivedIds, candidateIds: [staged.id] }
    : { kind: "staged", candidateIds: [staged.id] };
}

/** Idempotency identity from the durable body block first; sidecar only as legacy fallback. */
function durableProvenance(
  candidate: ReviewCandidate,
): { idempotencyKey: string; contentHash: string } | undefined {
  const block = connectorBlockFromBody(candidate.body);
  if (block) return { idempotencyKey: block.idempotencyKey, contentHash: block.contentHash };
  return candidate.connectorProvenance;
}

/** The candidate ids a run with these inputs could touch, resolved before any fetch. */
async function supersedableCandidates(
  root: string,
  connectorId: string,
  canonicalSourceId: string,
): Promise<SupersedableCandidates> {
  const key = idempotencyKey(connectorId, canonicalSourceId);
  const existingIds = (await listCandidates(root))
    .filter((candidate) => durableProvenance(candidate)?.idempotencyKey === key)
    .map((candidate) => candidate.id);
  return { existingIds, preflightStagedId: preflightCandidateId(hostSlug(connectorId, canonicalSourceId)) };
}

/** Archive superseded candidates; on any failure restore the already-moved ones and fail closed. */
async function archiveCandidatesWithUndo(root: string, candidates: ReviewCandidate[]): Promise<boolean> {
  const moved: string[] = [];
  for (const candidate of candidates) {
    if (!(await tryArchiveCandidate(root, candidate.id))) {
      await restoreArchivedCandidates(root, moved);
      return false;
    }
    moved.push(candidate.id);
  }
  return true;
}

/** Report an archive failure as false instead of leaking a raw filesystem error. */
async function tryArchiveCandidate(root: string, id: string): Promise<boolean> {
  try {
    return await archiveCandidate(root, id);
  } catch {
    return false;
  }
}

/** Best-effort compensation: move archived candidates back into the pending queue. */
async function restoreArchivedCandidates(root: string, ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await restoreArchivedCandidate(root, id);
    } catch {
      // Best-effort: the archived copy remains on disk for manual recovery.
    }
  }
}

/** Stage the replacement candidate, restoring the archived ones if staging throws. */
async function stageReplacementOrRestore(
  root: string,
  draft: PreparedDraft,
  profile: ProfilePack,
  archivedIds: string[],
  now?: () => Date,
): Promise<StagedChange> {
  try {
    return await stageEntityPage(root, {
      entityType: draft.entityType,
      slug: draft.slug,
      body: draft.body,
      profile,
      existingStagedCount: 0,
      now,
      reviewMode: "connector",
      heldReasons: [{ code: "connector-fetched" }],
      connectorProvenance: draft.provenance,
      freshCandidateId: archivedIds.length > 0,
    });
  } catch (err) {
    await restoreArchivedCandidates(root, archivedIds);
    throw err;
  }
}

/** Conservative upper-bound candidate id used before the real random id exists. */
function preflightCandidateId(slug: string): string {
  return `${slug}-${PREFLIGHT_CANDIDATE_SUFFIX}`;
}

/** Host-computed stable idempotency key from connector id and canonical source id. */
function idempotencyKey(connectorId: string, canonicalSourceId: string): string {
  return sha256Text(`${connectorId}\n${canonicalSourceId}`);
}

/** Host-computed slug, never response-derived. */
function hostSlug(connectorId: string, canonicalSourceId: string): string {
  const suffix = canonicalSourceId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  return `${connectorId}-${suffix || "source"}`;
}

/** Build the polite connector User-Agent. */
function politeUserAgent(version: string, contactEmail: string): string {
  return `llmwiki/${version} (mailto:${contactEmail})`;
}

/** Compose a typed markdown body with durable connector frontmatter. */
function composeBody(
  mapped: Record<string, unknown>,
  content: string,
  block: DurableConnectorBlock,
): string {
  return `${buildFrontmatter({ ...mapped, [CONNECTOR_BLOCK_KEY]: block })}\n${content}`;
}

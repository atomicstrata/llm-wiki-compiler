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
import { acquireMutationLock } from "../operation-bundles/lock-gate.js";
import { appendEventLocked, preflightEventAppend } from "../events/store.js";
import { releaseLock } from "../utils/lock.js";
import { getConnectorDef } from "./registry.js";
import {
  appendConnectorEvent,
  connectorEvent,
  preflightAuditCapacity,
  type SupersedableCandidates,
} from "./audit.js";
import { sha256Text } from "./hash.js";
import { confinedFetch, validateConnectorHeaders, type ConfinedFetchResult, type FetchLimits } from "./confined-fetch.js";
import { isConnectorActivated, loadConnectorConfig, type ConnectorRuntimeConfig } from "./config.js";
import { CONNECTOR_BLOCK_KEY } from "./fence.js";
import {
  archiveCandidatesWithUndo,
  canStageFreshConnectorIntent,
  CONNECTOR_CANDIDATE_STORE_UNAVAILABLE,
  includesConnectorContentHash,
  selectConnectorCandidateEntriesForRun,
  type CandidateMovePort,
} from "./candidate-supersession.js";
import {
  stageConnectorCandidate,
  type ConnectorCandidateStageResult,
} from "./stage-candidate.js";
import { enforceRequestInterval } from "./rate-limit.js";
import { captureConnectorResult } from "./candidate-batch.js";
import { captureConnectorInputs } from "./input-validation.js";
import {
  captureConnectorIdentity,
  INVALID_CONNECTOR_IDENTITY,
  preflightCandidateId,
  stagedCandidatePreflightId,
  type ConnectorCandidateIdentity,
} from "./candidate-identity.js";
import type { ConnectorBindingDef, ConnectorProvenance, ConnectorRequest, DurableConnectorBlock } from "./types.js";
import type { LoadedProfile, ProfilePack } from "../profile/types.js";
import { CandidatePublicationUnavailableError, FreshCandidateIdExhaustedError } from "../compiler/candidates.js";
import { CandidateCustodyUnavailableError } from "../compiler/candidate-custody.js";
import { UnsafeCandidateDirError } from "../compiler/candidate-store-paths.js";
import type { CandidateMutationSelectionHooks } from "../compiler/candidate-selection.js";
import { StagedWriteOverflowError } from "../trust/staged-change.js";

const PACKAGE_VERSION = packageJson.version;

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_FETCH_MAX_BYTES = 1_000_000;
const DEFAULT_FETCH_REDIRECTS = 3;
const DEFAULT_FETCH_CONTENT_TYPES = ["application/json", "text/plain"] as const;

/** Outcome of one host-mediated connector run. */
export type RunConnectorResult =
  | { kind: "staged"; candidateIds: readonly string[] }
  | { kind: "noop"; candidateIds: readonly string[] }
  | { kind: "superseded"; archivedIds: readonly string[]; candidateIds: readonly string[] }
  | { kind: "recovery-required"; candidateIds: readonly string[] }
  | { kind: "refused"; reason: string }
  | { kind: "unavailable"; reason: string };

/** Test seams for deterministic offline connector runs. */
export interface RunConnectorDeps {
  fetcher?: (request: ConnectorRequest, limits: FetchLimits, allowedHosts: readonly string[]) => Promise<ConfinedFetchResult>;
  now?: () => Date;
  candidateMoves?: CandidateMovePort;
  beforeCandidateStageForTest?: () => Promise<void>;
  candidateSelectionHooksForTest?: CandidateMutationSelectionHooks;
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
type CandidateUnavailable = Extract<RunConnectorResult, { kind: "unavailable" }>;

/** Run one activated connector and stage its mapped draft as a typed review candidate. */
export async function runConnector(
  root: string,
  connectorId: string,
  inputs: Record<string, string>,
  deps: RunConnectorDeps = {},
): Promise<RunConnectorResult> {
  const prepared = await prepareConnectorDraft(root, connectorId, inputs, deps);
  if ("kind" in prepared) return checkedPublicResult(prepared);
  if (!(await acquireMutationLock(root, "ordinary", { quiet: true }))) {
    return checkedPublicResult({ kind: "unavailable", reason: "connector candidate store locked" });
  }
  try {
    return checkedPublicResult(
      await stagePreparedDraft(root, prepared, deps),
    );
  } finally {
    await releaseLock(root);
  }
}

/** Recheck candidate arrays before any connector result leaves core. */
function checkedPublicResult(result: RunConnectorResult): RunConnectorResult {
  try {
    return captureConnectorResult(result, "public") as RunConnectorResult;
  } catch {
    return captureConnectorResult({
      kind: "unavailable",
      reason: "connector returned invalid candidate identities",
    }) as RunConnectorResult;
  }
}

/** The pre-fetch gate outcome: everything the fetch and compose phases need. */
interface GatedConnectorRun {
  context: Awaited<Exclude<Awaited<ReturnType<typeof loadConnectorProfile>>, RunConnectorResult>>;
  identity: ConnectorCandidateIdentity;
  request: ConnectorRequest;
  allowedHosts: readonly string[];
  inputs: Readonly<Record<string, string>>;
}

/** Profile, identity, and runtime config resolved before request construction. */
interface ConnectorRunSetup {
  context: GatedConnectorRun["context"];
  identity: ConnectorCandidateIdentity;
  config: ConnectorRuntimeConfig;
  inputs: Readonly<Record<string, string>>;
}

/** Resolve profile/binding/config, fetch external bytes, parse one draft, and compose the candidate body. */
async function prepareConnectorDraft(
  root: string,
  connectorId: string,
  inputs: Record<string, string>,
  deps: RunConnectorDeps,
): Promise<PreparedDraft | RunConnectorResult> {
  const gated = await gateConnectorRun(root, connectorId, inputs, deps);
  if ("kind" in gated) return gated;
  const fetched = await (deps.fetcher ?? confinedFetch)(gated.request, fetchLimitsFor(gated.request), gated.allowedHosts);
  if (fetched.kind !== "ok") return fetched;
  return composePreparedDraft(gated.context, gated.identity, gated.inputs, fetched, deps.now);
}

/** Every pre-fetch gate: profile binding, input contract, config floors, headers, audit capacity, rate interval. */
async function gateConnectorRun(
  root: string,
  connectorId: string,
  inputs: Record<string, string>,
  deps: RunConnectorDeps,
): Promise<GatedConnectorRun | RunConnectorResult> {
  const setup = await resolveConnectorRunSetup(root, connectorId, inputs);
  if ("kind" in setup) return setup;
  const request = buildConnectorRequest(
    setup.context.def.buildRequest(setup.inputs as Record<string, string>),
    setup.config.contactEmail,
  );
  return finishConnectorGate(root, connectorId, setup, request, deps);
}

/** Resolve profile binding, input contract, immutable identity, and config. */
async function resolveConnectorRunSetup(
  root: string,
  connectorId: string,
  inputs: Record<string, string>,
): Promise<ConnectorRunSetup | RunConnectorResult> {
  const context = await loadConnectorProfile(root, connectorId);
  if ("kind" in context) return context;
  const inputCapture = captureConnectorInputs(context.def.inputs, inputs);
  if (inputCapture.kind !== "ok") return inputCapture;
  const identity = captureConnectorIdentity(
    context.def,
    inputCapture.inputs as Record<string, string>,
  );
  if (identity === null) return { kind: "refused", reason: INVALID_CONNECTOR_IDENTITY };
  const config = await loadRunnableConnectorConfig(root, connectorId, context.def);
  if (config.kind !== "ok") return config;
  return { context, identity, config: config.config, inputs: inputCapture.inputs };
}

/** Complete request, candidate, audit, and rate gates before external fetch. */
async function finishConnectorGate(
  root: string,
  connectorId: string,
  setup: ConnectorRunSetup,
  request: ConnectorRequest,
  deps: RunConnectorDeps,
): Promise<GatedConnectorRun | RunConnectorResult> {
  const headers = validateConnectorHeaders(request.headers ?? {});
  if (headers.kind !== "ok") return headers;
  const supersedable = await supersedableCandidates(root, setup.identity, deps.candidateSelectionHooksForTest);
  if ("kind" in supersedable) return supersedable;
  const audit = await preflightAuditCapacity(root, setup.identity, supersedable, deps.now, "public");
  if (audit) return audit;
  const interval = await enforceRequestInterval(root, connectorId, setup.config, deps.now);
  if (interval) return interval;
  return {
    context: setup.context,
    identity: setup.identity,
    request,
    allowedHosts: setup.config.allowedHosts,
    inputs: setup.inputs,
  };
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
  identity: ConnectorCandidateIdentity,
  inputs: Record<string, string>,
  fetched: Extract<ConfinedFetchResult, { kind: "ok" }>,
  now?: () => Date,
): PreparedDraft | RunConnectorResult {
  const drafts = context.def.parse(fetched.bytes.toString("utf8"), inputs);
  if (drafts.length !== 1) return { kind: "refused", reason: "connector must return exactly one draft" };
  const draft = drafts[0]!;
  const content = connectorBodyContent(context.binding, draft);
  if (typeof content !== "string") return content;
  const mapped = mapDraftFields(context.profile, context.binding, draft.fields);
  if ("kind" in mapped) return mapped;
  const block = durableConnectorBlock(
    identity, fetched, mapped.externalFields, now,
  );
  const body = composeBody(mapped.fields, content, block);
  const draftContentHash = sha256Text(body);
  return {
    entityType: context.binding.entityType,
    slug: identity.slug,
    body,
    provenance: { ...block, draftContentHash },
    idempotencyKey: identity.idempotencyKey,
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
  identity: ConnectorCandidateIdentity,
  fetched: Extract<ConfinedFetchResult, { kind: "ok" }>,
  externalFields: string[],
  now?: () => Date,
): DurableConnectorBlock {
  return {
    connectorId: identity.connectorId,
    connectorVersion: identity.connectorVersion,
    sourceUrl: fetched.finalUrl,
    fetchedAt: (now ? now() : new Date()).toISOString(),
    contentHash: fetched.contentHash,
    idempotencyKey: identity.idempotencyKey,
    externalFields,
  };
}

/** Mutate the candidate store under the held project lock and append the audit event. */
async function stagePreparedDraft(
  root: string,
  draft: PreparedDraft,
  deps: RunConnectorDeps,
): Promise<RunConnectorResult> {
  const selection = await selectConnectorCandidateEntriesForRun(root, draft.idempotencyKey,
    deps.candidateSelectionHooksForTest);
  if ("kind" in selection) return selection;
  const existing = selection.entries;
  const candidateIds = existing.map(({ fileId }) => fileId);
  if (includesConnectorContentHash(existing, draft.contentHash)) {
    const event = connectorEvent(draft, [], candidateIds, [], deps.now, "public");
    await preflightEventAppend(root, event);
    await appendEventLocked(root, event);
    return { kind: "noop", candidateIds };
  }
  if (!canStageFreshConnectorIntent(selection)) return candidateStoreUnavailable();
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) return { kind: "unavailable", reason: "connector profile unavailable" };
  const preflightIds = [stagedCandidatePreflightId(draft.slug)];
  const archivedIds = candidateIds;
  await preflightEventAppend(root, connectorEvent(draft, preflightIds, [], archivedIds, deps.now, "public"));
  const archived = await archiveCandidatesWithUndo(root, existing, deps.candidateMoves, "public");
  if (archived.kind === "recovery-required") return archived;
  if (archived.kind === "failed-and-restored") {
    return { kind: "unavailable", reason: "connector could not archive a superseded candidate" };
  }
  const staged = await stageReplacement(root, draft, loaded.profile, archived.receipts, deps);
  if (staged.kind !== "staged") return staged;
  await appendConnectorEvent(root, draft, [staged.change.id], [], archivedIds, deps.now, "public");
  return archivedIds.length > 0
    ? { kind: "superseded", archivedIds, candidateIds: [staged.change.id] }
    : { kind: "staged", candidateIds: [staged.change.id] };
}

/** Stage after archive; map only errors whose exact compensation already settled. */
async function stageReplacement(
  root: string,
  draft: PreparedDraft,
  profile: ProfilePack,
  receipts: Parameters<typeof stageConnectorCandidate>[3],
  deps: RunConnectorDeps,
): Promise<ConnectorCandidateStageResult | CandidateUnavailable> {
  try {
    return await stageConnectorCandidate(
      root, draft, profile, receipts, deps.candidateMoves, deps.now,
      deps.beforeCandidateStageForTest, "public",
    );
  } catch (error) {
    if (error instanceof StagedWriteOverflowError ||
        error instanceof FreshCandidateIdExhaustedError ||
        error instanceof CandidatePublicationUnavailableError ||
        error instanceof CandidateCustodyUnavailableError ||
        error instanceof UnsafeCandidateDirError) return candidateStoreUnavailable();
    throw error;
  }
}

/** Build the one fixed normal-run candidate-authority refusal. */
function candidateStoreUnavailable(): CandidateUnavailable {
  return { kind: "unavailable", reason: CONNECTOR_CANDIDATE_STORE_UNAVAILABLE };
}

/** The candidate ids a run with these inputs could touch, resolved before any fetch. */
async function supersedableCandidates(
  root: string,
  identity: ConnectorCandidateIdentity,
  hooks?: CandidateMutationSelectionHooks,
): Promise<SupersedableCandidates | RunConnectorResult> {
  const selection = await selectConnectorCandidateEntriesForRun(root, identity.idempotencyKey, hooks);
  if ("kind" in selection) return selection;
  return {
    existingIds: selection.entries.map(({ fileId }) => fileId),
    preflightStagedId: preflightCandidateId(identity.slug),
  };
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

/**
 * @file src/connectors/run.ts
 * @description Connector substrate: activation, fetch, provenance, idempotency, and staging.
 *
 * Profiles contain only pure connector bindings. This module is the host-owned
 * execution boundary: it checks the operator activation env var, loads
 * tighten-only project config, performs the host-mediated fetch, maps exactly one
 * connector draft into a typed staged entity page, and appends an audit event.
 * Candidate-store mutations run under the project lock so supersede and review
 * approval cannot interleave on the same pending candidate. The staging itself,
 * under that lock, is `stage-draft.ts`.
 *
 * THE WHOLE RUN HAS ONE BODY, {@link runConnectorWith}, over
 * {@link ConnectorRunSteps}, none of which takes a project root: the profile, the
 * config, the supersedable selection, the audit preflight, the rate interval, the
 * lock and the locked stage. Every gate, its order (the rate interval is spent
 * before the fetch; the lock is taken after it), the draft composition and the
 * public result check are decided there. The registry, the activation env var and
 * the fetch stay provider/host collaborators. {@link runConnector} hands it the
 * disk steps, which call the incumbent root forms with their old arguments.
 */

import { indexedActive } from "../indexed/routing.js";
import packageJson from "../../package.json";
import { buildFrontmatter } from "../utils/markdown.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import { acquireMutationLock } from "../operation-bundles/lock-gate.js";
import { releaseLock } from "../utils/lock.js";
import { getConnectorDef } from "./registry.js";
import { preflightAuditCapacity, type SupersedableCandidates } from "./audit.js";
import { sha256Text } from "./hash.js";
import { confinedFetch, validateConnectorHeaders, type ConfinedFetchResult, type FetchLimits } from "./confined-fetch.js";
import { isConnectorActivated, loadConnectorConfig, type ConnectorConfigRead, type ConnectorRuntimeConfig } from "./config.js";
import { CONNECTOR_BLOCK_KEY } from "./fence.js";
import { selectConnectorCandidateEntriesForRun, type CandidateMovePort, type ConnectorCandidateEntriesResult } from "./candidate-supersession.js";
import { stagePreparedDraft, type PreparedDraft } from "./stage-draft.js";
import { enforceRequestInterval } from "./rate-limit.js";
import { captureConnectorResult } from "./candidate-batch.js";
import { captureConnectorInputs } from "./input-validation.js";
import {
  captureConnectorIdentity,
  INVALID_CONNECTOR_IDENTITY,
  preflightCandidateId,
  type ConnectorCandidateIdentity,
} from "./candidate-identity.js";
import type { ConnectorBindingDef, ConnectorRequest, DurableConnectorBlock } from "./types.js";
import type { LoadedProfile, ProfilePack } from "../profile/types.js";
import type { CandidateMutationSelectionHooks } from "../compiler/candidate-selection.js";
import type { CandidateCustodyPolicy } from "../compiler/candidate-custody-limits.js";

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

type ConnectorConfigResult = { kind: "ok"; config: ConnectorRuntimeConfig } | RunConnectorResult;

/**
 * Everything a connector run touches in the project, none taking a project root.
 * Each is one call; the gates, their order and the result are {@link runConnectorWith}'s.
 */
export interface ConnectorRunSteps {
  loadProfile(): Promise<LoadedProfile | undefined>;
  loadConfig(connectorId: string, registryHosts: readonly string[], defaultMinIntervalMs: number): Promise<ConnectorConfigRead>;
  /** The pending candidates a run with this idempotency key could supersede. */
  selectCandidates(idempotencyKey: string, hooks?: CandidateMutationSelectionHooks): Promise<ConnectorCandidateEntriesResult>;
  preflightAudit(
    identity: ConnectorCandidateIdentity, supersedable: SupersedableCandidates, now: (() => Date) | undefined, policy: CandidateCustodyPolicy,
  ): Promise<RunConnectorResult | null>;
  /** Check and spend the connector's request interval (a refusal when too soon). */
  enforceInterval(connectorId: string, config: ConnectorRuntimeConfig, now?: () => Date): Promise<RunConnectorResult | null>;
  /** Take the project lock quietly (false when another run holds it). */
  acquireLock(): Promise<boolean>;
  releaseLock(): Promise<void>;
  /** Stage the prepared draft under the held lock. */
  stage(prepared: PreparedDraft, deps: RunConnectorDeps): Promise<RunConnectorResult>;
}

/** LOCAL DISK. The run steps for the project at `root`: the incumbent root forms, old arguments. */
function diskConnectorRunSteps(root: string): ConnectorRunSteps {
  return {
    loadProfile: () => loadNonDefaultProfile(root),
    loadConfig: (connectorId, registryHosts, defaultMinIntervalMs) => loadConnectorConfig(root, connectorId, registryHosts, defaultMinIntervalMs),
    selectCandidates: (idempotencyKey, hooks) => selectConnectorCandidateEntriesForRun(root, idempotencyKey, hooks),
    preflightAudit: (identity, supersedable, now, policy) => preflightAuditCapacity(root, identity, supersedable, now, policy),
    enforceInterval: (connectorId, config, now) => enforceRequestInterval(root, connectorId, config, now),
    acquireLock: () => acquireMutationLock(root, "ordinary", { quiet: true }),
    releaseLock: () => releaseLock(root),
    stage: (prepared, deps) => stagePreparedDraft(root, prepared, deps),
  };
}

/**
 * Run one activated connector and stage its mapped draft as a typed review
 * candidate. On a `local-indexed` project the run is refused BEFORE any fetch
 * or mutation: connector staging is not part of the indexed route.
 */
export async function runConnector(
  root: string,
  connectorId: string,
  inputs: Record<string, string>,
  deps: RunConnectorDeps = {},
): Promise<RunConnectorResult> {
  if (await indexedActive(root)) return { kind: "refused", reason: "connectors are unavailable on a local-indexed project" };
  return runConnectorWith(diskConnectorRunSteps(root), connectorId, inputs, deps);
}

/**
 * {@link runConnector} over {@link ConnectorRunSteps}: THE ONE BODY. Every
 * pre-fetch gate, the fetch, the composition, then the lock (taken only after the
 * fetch) and the locked stage; every result leaves through the public check.
 */
export async function runConnectorWith(
  steps: ConnectorRunSteps,
  connectorId: string,
  inputs: Record<string, string>,
  deps: RunConnectorDeps,
): Promise<RunConnectorResult> {
  const prepared = await prepareConnectorDraft(steps, connectorId, inputs, deps);
  if ("kind" in prepared) return checkedPublicResult(prepared);
  if (!(await steps.acquireLock())) {
    return checkedPublicResult({ kind: "unavailable", reason: "connector candidate store locked" });
  }
  try {
    return checkedPublicResult(
      await steps.stage(prepared, deps),
    );
  } finally {
    await steps.releaseLock();
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
  steps: ConnectorRunSteps,
  connectorId: string,
  inputs: Record<string, string>,
  deps: RunConnectorDeps,
): Promise<PreparedDraft | RunConnectorResult> {
  const gated = await gateConnectorRun(steps, connectorId, inputs, deps);
  if ("kind" in gated) return gated;
  const fetched = await (deps.fetcher ?? confinedFetch)(gated.request, fetchLimitsFor(gated.request), gated.allowedHosts);
  if (fetched.kind !== "ok") return fetched;
  return composePreparedDraft(gated.context, gated.identity, gated.inputs, fetched, deps.now);
}

/** Every pre-fetch gate: profile binding, input contract, config floors, headers, audit capacity, rate interval. */
async function gateConnectorRun(
  steps: ConnectorRunSteps,
  connectorId: string,
  inputs: Record<string, string>,
  deps: RunConnectorDeps,
): Promise<GatedConnectorRun | RunConnectorResult> {
  const setup = await resolveConnectorRunSetup(steps, connectorId, inputs);
  if ("kind" in setup) return setup;
  const request = buildConnectorRequest(
    setup.context.def.buildRequest(setup.inputs as Record<string, string>),
    setup.config.contactEmail,
  );
  return finishConnectorGate(steps, connectorId, setup, request, deps);
}

/** Resolve profile binding, input contract, immutable identity, and config. */
async function resolveConnectorRunSetup(
  steps: ConnectorRunSteps,
  connectorId: string,
  inputs: Record<string, string>,
): Promise<ConnectorRunSetup | RunConnectorResult> {
  const context = await loadConnectorProfile(steps, connectorId);
  if ("kind" in context) return context;
  const inputCapture = captureConnectorInputs(context.def.inputs, inputs);
  if (inputCapture.kind !== "ok") return inputCapture;
  const identity = captureConnectorIdentity(
    context.def,
    inputCapture.inputs as Record<string, string>,
  );
  if (identity === null) return { kind: "refused", reason: INVALID_CONNECTOR_IDENTITY };
  const config = await loadRunnableConnectorConfig(steps, connectorId, context.def);
  if (config.kind !== "ok") return config;
  return { context, identity, config: config.config, inputs: inputCapture.inputs };
}

/** Complete request, candidate, audit, and rate gates before external fetch. */
async function finishConnectorGate(
  steps: ConnectorRunSteps,
  connectorId: string,
  setup: ConnectorRunSetup,
  request: ConnectorRequest,
  deps: RunConnectorDeps,
): Promise<GatedConnectorRun | RunConnectorResult> {
  const headers = validateConnectorHeaders(request.headers ?? {});
  if (headers.kind !== "ok") return headers;
  const supersedable = await supersedableCandidates(steps, setup.identity, deps.candidateSelectionHooksForTest);
  if ("kind" in supersedable) return supersedable;
  const audit = await steps.preflightAudit(setup.identity, supersedable, deps.now, "public");
  if (audit) return audit;
  const interval = await steps.enforceInterval(connectorId, setup.config, deps.now);
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
  steps: ConnectorRunSteps,
  connectorId: string,
  def: NonNullable<ReturnType<typeof getConnectorDef>>,
): Promise<ConnectorConfigResult> {
  if (!isConnectorActivated(connectorId)) return { kind: "refused", reason: "connector is not activated" };
  const config = await steps.loadConfig(connectorId, def.allowedHosts, def.minRequestIntervalMs ?? 0);
  if (config.kind === "unavailable") return { kind: "unavailable", reason: config.reason };
  if (def.requiresContactEmail && !config.config.contactEmail) {
    return { kind: "refused", reason: "connector requires contactEmail" };
  }
  return { kind: "ok", config: config.config };
}

/** Load the active non-default profile and its binding for `connectorId`. */
async function loadConnectorProfile(
  steps: ConnectorRunSteps,
  connectorId: string,
): Promise<{ loaded: LoadedProfile; profile: ProfilePack; binding: ConnectorBindingDef; def: NonNullable<ReturnType<typeof getConnectorDef>> } | RunConnectorResult> {
  const def = getConnectorDef(connectorId);
  if (!def) return { kind: "refused", reason: "unknown connector" };
  const loaded = await steps.loadProfile();
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

/** The candidate ids a run with these inputs could touch, resolved before any fetch. */
async function supersedableCandidates(
  steps: ConnectorRunSteps,
  identity: ConnectorCandidateIdentity,
  hooks?: CandidateMutationSelectionHooks,
): Promise<SupersedableCandidates | RunConnectorResult> {
  const selection = await steps.selectCandidates(identity.idempotencyKey, hooks);
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

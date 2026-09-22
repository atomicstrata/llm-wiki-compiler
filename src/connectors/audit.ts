/**
 * @file src/connectors/audit.ts
 * @description The connector-fetch audit event: payload shape, builders, and the
 * pre-fetch capacity gate.
 *
 * Every connector staging outcome is recorded in the append-only event store.
 * Before any external fetch, {@link preflightAuditCapacity} checks a padded
 * upper-bound event against the store caps so a full store never costs an
 * unaudited fetch or a rate-stamp spend; the staging-time preflight under the
 * mutation lock remains the byte-exact authority.
 */

import { appendEventLocked, preflightEventAppend, type AppendEventInput } from "../events/store.js";
import { releaseLock } from "../utils/lock.js";
import { acquireMutationLock } from "../operation-bundles/lock-gate.js";
import { MAX_CONNECTOR_URL_BYTES } from "./confined-fetch.js";
import {
  assertConnectorCandidateBatchCount,
  captureConnectorCandidateIds,
} from "./candidate-batch.js";
import type { RunConnectorResult } from "./run.js";
import type { CandidateCustodyPolicy } from "../compiler/candidate-custody-limits.js";

/** Runtime byte cap applied to each connector input value. */
export const MAX_CONNECTOR_INPUT_BYTES = 512;

/** Payload recorded in the append-only event store after connector staging. */
interface ConnectorFetchEventPayload {
  connectorId: string;
  connectorVersion: string;
  finalUrl: string;
  contentHash: string;
  draftContentHash?: string;
  idempotencyKey: string;
  stagedCandidateIds: readonly string[];
  noopCandidateIds: readonly string[];
  supersededCandidateIds: readonly string[];
}

/** The event-relevant identity of one prepared connector draft. */
export interface ConnectorAuditDraft {
  provenance: { connectorId: string; connectorVersion: string };
  finalUrl: string;
  contentHash: string;
  draftContentHash: string;
  idempotencyKey: string;
}

/** Captured connector identity fields authorized to enter audit records. */
export interface ConnectorAuditIdentity {
  readonly connectorId: string;
  readonly connectorVersion: string;
}

/** The candidate ids a run could touch, resolved from inputs before any fetch. */
export interface SupersedableCandidates {
  existingIds: readonly string[];
  preflightStagedId: string;
}

/**
 * Refuse to dial out when the event store cannot take the staging audit event,
 * so a full store never costs an unaudited external fetch or a rate-stamp spend.
 * Runs under its own short lock acquisition; {@link EventStoreFullError} propagates.
 */
export async function preflightAuditCapacity(
  root: string,
  identity: ConnectorAuditIdentity,
  supersedable: SupersedableCandidates,
  now?: () => Date,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<RunConnectorResult | null> {
  if (!(await acquireMutationLock(root, "ordinary", { quiet: true }))) {
    return { kind: "unavailable", reason: "connector event store locked" };
  }
  try {
    await preflightEventAppend(root, upperBoundConnectorEvent(identity, supersedable, now, policy));
    return null;
  } finally {
    await releaseLock(root);
  }
}

/**
 * A worst-case stand-in for the staging event, checked BEFORE any external fetch.
 * Every variable field dominates its runtime value: finalUrl is padded to the hard
 * per-hop URL cap, the staged bucket carries the over-long preflight id, and BOTH
 * remaining buckets carry the actual supersedable candidate ids (a superset of the
 * real noop-vs-supersede split). Only candidates appearing after this gate — a
 * concurrent writer — can grow the real event past it; the staging-time preflight
 * under the mutation lock remains the byte-exact authority.
 */
export function upperBoundConnectorEvent(
  identity: ConnectorAuditIdentity,
  supersedable: SupersedableCandidates,
  now?: () => Date,
  policy: CandidateCustodyPolicy = "bounded",
): AppendEventInput {
  const existingIds = captureConnectorCandidateIds(supersedable.existingIds, policy);
  assertConnectorCandidateBatchCount([supersedable.preflightStagedId]);
  const hash = "f".repeat(64);
  const payload: ConnectorFetchEventPayload = {
    connectorId: identity.connectorId,
    connectorVersion: identity.connectorVersion,
    finalUrl: "f".repeat(MAX_CONNECTOR_URL_BYTES),
    contentHash: hash,
    draftContentHash: hash,
    idempotencyKey: hash,
    stagedCandidateIds: [supersedable.preflightStagedId],
    noopCandidateIds: existingIds,
    supersededCandidateIds: existingIds,
  };
  return {
    type: "connector-fetch",
    origin: "connector",
    payload: payload as unknown as Record<string, unknown>,
    at: (now ? now() : new Date()).toISOString(),
  };
}

/** Append the connector-fetch event using the same values returned to the caller. */
export async function appendConnectorEvent(
  root: string,
  draft: ConnectorAuditDraft,
  stagedCandidateIds: readonly string[],
  noopCandidateIds: readonly string[],
  supersededCandidateIds: readonly string[],
  now?: () => Date,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<unknown> {
  return appendEventLocked(root, connectorEvent(draft, stagedCandidateIds, noopCandidateIds, supersededCandidateIds, now, policy));
}

/** Build the connector-fetch event payload without mutating the event store. */
export function connectorEvent(
  draft: ConnectorAuditDraft,
  stagedCandidateIds: readonly string[],
  noopCandidateIds: readonly string[],
  supersededCandidateIds: readonly string[],
  now?: () => Date,
  policy: CandidateCustodyPolicy = "bounded",
): AppendEventInput {
  const staged = captureConnectorCandidateIds(stagedCandidateIds, policy);
  const noop = captureConnectorCandidateIds(noopCandidateIds, policy);
  const superseded = captureConnectorCandidateIds(supersededCandidateIds, policy);
  const payload: ConnectorFetchEventPayload = Object.freeze({
    connectorId: draft.provenance.connectorId,
    connectorVersion: draft.provenance.connectorVersion,
    finalUrl: draft.finalUrl,
    contentHash: draft.contentHash,
    draftContentHash: draft.draftContentHash,
    idempotencyKey: draft.idempotencyKey,
    stagedCandidateIds: staged,
    noopCandidateIds: noop,
    supersededCandidateIds: superseded,
  });
  return Object.freeze({
    type: "connector-fetch",
    origin: "connector",
    payload: payload as unknown as Record<string, unknown>,
    at: (now ? now() : new Date()).toISOString(),
  });
}

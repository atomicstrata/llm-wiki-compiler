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
import { acquireLock, releaseLock } from "../utils/lock.js";
import { MAX_CONNECTOR_URL_BYTES } from "./confined-fetch.js";
import type { ConnectorDef } from "./types.js";
import type { RunConnectorResult } from "./run.js";

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
  stagedCandidateIds: string[];
  noopCandidateIds: string[];
  supersededCandidateIds: string[];
}

/** The event-relevant identity of one prepared connector draft. */
export interface ConnectorAuditDraft {
  provenance: { connectorId: string; connectorVersion: string };
  finalUrl: string;
  contentHash: string;
  draftContentHash: string;
  idempotencyKey: string;
}

/** The candidate ids a run could touch, resolved from inputs before any fetch. */
export interface SupersedableCandidates {
  existingIds: string[];
  preflightStagedId: string;
}

/**
 * Refuse to dial out when the event store cannot take the staging audit event,
 * so a full store never costs an unaudited external fetch or a rate-stamp spend.
 * Runs under its own short lock acquisition; {@link EventStoreFullError} propagates.
 */
export async function preflightAuditCapacity(
  root: string,
  def: Pick<ConnectorDef, "id" | "version">,
  supersedable: SupersedableCandidates,
  now?: () => Date,
): Promise<RunConnectorResult | null> {
  if (!(await acquireLock(root, { quiet: true }))) {
    return { kind: "unavailable", reason: "connector event store locked" };
  }
  try {
    await preflightEventAppend(root, upperBoundConnectorEvent(def, supersedable, now));
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
  def: Pick<ConnectorDef, "id" | "version">,
  supersedable: SupersedableCandidates,
  now?: () => Date,
): AppendEventInput {
  const hash = "f".repeat(64);
  const payload: ConnectorFetchEventPayload = {
    connectorId: def.id,
    connectorVersion: def.version,
    finalUrl: "f".repeat(MAX_CONNECTOR_URL_BYTES),
    contentHash: hash,
    draftContentHash: hash,
    idempotencyKey: hash,
    stagedCandidateIds: [supersedable.preflightStagedId],
    noopCandidateIds: supersedable.existingIds,
    supersededCandidateIds: supersedable.existingIds,
  };
  return {
    type: "connector-fetch",
    origin: "connector",
    payload: payload as unknown as Record<string, unknown>,
    at: (now ? now() : new Date()).toISOString(),
  };
}

/** Append the connector-fetch event using the same values returned to the caller. */
export function appendConnectorEvent(
  root: string,
  draft: ConnectorAuditDraft,
  stagedCandidateIds: string[],
  noopCandidateIds: string[],
  supersededCandidateIds: string[],
  now?: () => Date,
): Promise<unknown> {
  return appendEventLocked(root, connectorEvent(draft, stagedCandidateIds, noopCandidateIds, supersededCandidateIds, now));
}

/** Build the connector-fetch event payload without mutating the event store. */
export function connectorEvent(
  draft: ConnectorAuditDraft,
  stagedCandidateIds: string[],
  noopCandidateIds: string[],
  supersededCandidateIds: string[],
  now?: () => Date,
): AppendEventInput {
  const payload: ConnectorFetchEventPayload = {
    connectorId: draft.provenance.connectorId,
    connectorVersion: draft.provenance.connectorVersion,
    finalUrl: draft.finalUrl,
    contentHash: draft.contentHash,
    draftContentHash: draft.draftContentHash,
    idempotencyKey: draft.idempotencyKey,
    stagedCandidateIds,
    noopCandidateIds,
    supersededCandidateIds,
  };
  return {
    type: "connector-fetch",
    origin: "connector",
    payload: payload as unknown as Record<string, unknown>,
    at: (now ? now() : new Date()).toISOString(),
  };
}

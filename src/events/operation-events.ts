/**
 * @file src/events/operation-events.ts
 * @description The operation child-audit append. Its bounded content is derived
 * by the caller from a persisted authoritative result (never a caller-supplied
 * claim); this seam performs the mutation-identity lookup before appending so a
 * retry that matches an existing bound event appends nothing, and a bound event
 * whose content diverges from the retry parks as a conflict.
 *
 * ONE BODY: {@link appendOperationEventLocked} runs
 * {@link appendOperationEventLockedFrom} over local-disk
 * {@link EventBoundWriteSources}; the lookup, the match and the conflict
 * details stay here, and the append is the bound append's own body.
 */

import canonicalize from "canonicalize";
import type { OperationBinding } from "../utils/operation-binding.js";
import { operationBindingEquals } from "../utils/operation-binding.js";
import {
  appendBoundEventLockedFrom, diskEventBoundWriteSources, type AppendEventInput, type EventBoundWriteSources,
} from "./store.js";
import { readEventsFrom } from "./store-read.js";
import type { EventRecord, EventType } from "./types.js";

/** The bounded, result-derived content of one operation child audit event. */
export interface OperationEventContent {
  type: EventType;
  origin: string;
  payload: Record<string, unknown>;
  decision?: string;
  at: string;
}

/** Absent → created; exact retry → same; divergent bound record → conflict. */
export type OperationEventAppend =
  | { status: "created"; event: EventRecord }
  | { status: "same"; event: EventRecord }
  | { status: "conflict"; detail: string };

/** Whether a persisted bound event is the exact record this content would append. */
function eventMatches(event: EventRecord, content: OperationEventContent, binding: OperationBinding): boolean {
  return event.type === content.type
    && event.operationBinding !== undefined
    && operationBindingEquals(event.operationBinding, binding)
    && canonicalize(event.payload) === canonicalize(content.payload);
}

/**
 * Append (or idempotently reuse) the child audit event for one mutation, under
 * the caller's lock. Duplicate bound events for the mutation park; an exact
 * retry returns the existing record; otherwise the bound event is appended.
 */
export async function appendOperationEventLocked(
  root: string,
  content: OperationEventContent,
  binding: OperationBinding,
): Promise<OperationEventAppend> {
  return appendOperationEventLockedFrom(diskEventBoundWriteSources(root), content, binding);
}

/**
 * {@link appendOperationEventLocked} over {@link EventBoundWriteSources}: THE
 * ONE BODY. One read of the events, the lookup by mutation id, then at most one
 * bound append through the same sources.
 */
export async function appendOperationEventLockedFrom(
  sources: EventBoundWriteSources,
  content: OperationEventContent,
  binding: OperationBinding,
): Promise<OperationEventAppend> {
  const segmented = await sources.segmented?.();
  // local-indexed: the binding index (bounded); otherwise the incumbent whole read.
  const existing = segmented
    ? await segmented.findByMutation(binding.mutationId)
    : (await readEventsFrom(sources)).events.filter((event) => event.operationBinding?.mutationId === binding.mutationId);
  if (existing.length > 1) return { status: "conflict", detail: "duplicate operation event for mutation" };
  if (existing.length === 1) {
    return eventMatches(existing[0]!, content, binding)
      ? { status: "same", event: existing[0]! }
      : { status: "conflict", detail: "operation event content mismatch" };
  }
  const input: AppendEventInput = {
    type: content.type, origin: content.origin, payload: content.payload,
    ...(content.decision === undefined ? {} : { decision: content.decision }), at: content.at,
  };
  return { status: "created", event: await appendBoundEventLockedFrom(sources, input, binding) };
}

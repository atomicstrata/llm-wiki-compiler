/**
 * @file src/events/operation-events.ts
 * @description The operation child-audit append. Its bounded content is derived
 * by the caller from a persisted authoritative result (never a caller-supplied
 * claim); this seam performs the mutation-identity lookup before appending so a
 * retry that matches an existing bound event appends nothing, and a bound event
 * whose content diverges from the retry parks as a conflict.
 */

import canonicalize from "canonicalize";
import type { OperationBinding } from "../utils/operation-binding.js";
import { operationBindingEquals } from "../utils/operation-binding.js";
import { appendBoundEventLocked, type AppendEventInput } from "./store.js";
import { readEvents } from "./store-read.js";
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
  const { events } = await readEvents(root); // throws on corrupt/too-new/symlink
  const existing = events.filter(
    (event) => event.operationBinding?.mutationId === binding.mutationId,
  );
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
  return { status: "created", event: await appendBoundEventLocked(root, input, binding) };
}

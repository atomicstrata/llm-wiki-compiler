/**
 * @file src/portable/store/disk-open-operations.ts
 * @description The maintained open-operation view of a FORMAT-2 registered
 * directory: one marker per operation whose identity record is in progress.
 *
 * WHY. Format 1 finds open operations by reading every identity record the
 * project ever had, on every gated write. Format 2 cannot keep that lifetime
 * scan as its steady state (alignment §6.9), so the store maintains a marker
 * set under the gate instead and recovery reads only the markers.
 *
 * ORDER IS THE PROTOCOL, and every step fails closed:
 *
 * - an in-progress identity is written only AFTER its marker, and the marker
 *   carries a copy of that record, so a crash between the two never leaves an
 *   in-progress identity nobody lists;
 * - a terminal identity is written BEFORE its marker is removed, so a crash
 *   between leaves a stale marker that recovery removes on sight;
 * - a missing marker directory, or an entry that is not a regular file,
 *   cannot be read, is not a complete identity record, names another project
 *   or disagrees with its own file name, refuses `recovery_blocking`: it is
 *   never skipped, so it can neither hide unresolved work nor restore an
 *   invalid record. The ONE exception is the replacing writer's exact
 *   `<safeId>.json.<16 hex>.tmp` regular sibling (`disk-record-entries.ts`):
 *   the canonical marker is only ever replaced by rename, so that leftover
 *   is never a marker; it is skipped and left untouched.
 *
 * DURABILITY. A marker is written with the strict durable writer (file and
 * directory chain synced), and that write is awaited before the in-progress
 * identity is written, so under the filesystem's sync contract the marker is
 * made durable first. Physical power-loss behavior (drive caches included) is
 * not proved by this ordering. Removal stays non-durable: a marker that
 * reappears after a crash names a terminal identity, and is removed again on
 * sight. A sync failure throws before the caller's next step.
 *
 * The receipt and the durable close stay decisive (`authority/status.ts`): a
 * marker only says where to look.
 */

import type { OperationIdentityRecordV1 } from "../contracts.js";
import { PortableRefusal } from "../errors.js";
import { isSafeRecordId } from "../logical-paths.js";
import { listEntriesIfPresent, readProjectFile, removeProjectFile, writeProjectFileDurable } from "./disk-io.js";
import { ledgerDir, ledgerFile } from "./disk-layout.js";
import { isReplacingRecordTemp } from "./disk-record-entries.js";

/** Bound on one marker or identity record: they are small. */
const MAX_IDENTITY_BYTES = 1024 * 1024;

const KINDS: ReadonlySet<string> = new Set(["source.add", "proposal.persist", "approval.record", "candidate.apply"]);
const OUTCOMES: ReadonlySet<string> = new Set(["in-progress", "committed", "refused", "abandoned"]);

/** One marker as read back: the operation and the identity copied at begin. */
export interface OpenMarker { operationId: string; record: OperationIdentityRecordV1 }

/** Refuse any further write until an operator looks: the ledger cannot be trusted. */
export function ledgerBlocked(detail: string): PortableRefusal {
  return new PortableRefusal("recovery_blocking", detail);
}

/** True for a string or null. */
function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

/** True when `value` is a generation lease or null. */
function isLease(value: unknown): boolean {
  if (value === null) return true;
  const lease = value as Record<string, unknown> | undefined;
  return typeof lease === "object" && typeof lease.owner === "string" && typeof lease.epoch === "number" && typeof lease.expiresAt === "string";
}

/** True when `value` has every field of an identity record, with the right types. */
export function isIdentityRecord(value: unknown): value is OperationIdentityRecordV1 {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const holds = record.holds as Record<string, unknown> | null | undefined;
  const strings = ["tenant", "project", "actor", "hostIncarnation", "operationId", "intentDigest"];
  return strings.every((field) => typeof record[field] === "string")
    && KINDS.has(record.kind as string) && OUTCOMES.has(record.outcome as string)
    && isNullableString(record.refusal) && isNullableString(record.detail) && isNullableString(record.supersedes)
    && typeof holds === "object" && holds !== null && isNullableString(holds.approvalId) && isNullableString(holds.ticketId)
    && isLease(record.generationLease) && (record.resolution === null || typeof record.resolution === "object");
}

/**
 * Record that `record` (in progress) is open: durably, BEFORE the identity
 * record itself, and on every in-progress update.
 *
 * @throws when the strict durable write or its sync fails; the caller's identity write then never happens.
 */
export async function writeOpenMarker(root: string, record: OperationIdentityRecordV1): Promise<void> {
  await writeProjectFileDurable(root, ledgerFile("open", record.operationId), JSON.stringify(record));
}

/** Drop the marker of an operation whose identity is already terminal. */
export async function removeOpenMarker(root: string, operationId: string): Promise<void> {
  await removeProjectFile(root, ledgerFile("open", operationId));
}

/** Parse one marker, refusing anything that is not exactly this project's in-progress record under its own name. */
function parseMarker(operationId: string, bytes: Buffer | null, projectId: string): OpenMarker {
  if (bytes === null) throw ledgerBlocked(`open-operation marker unreadable: ${operationId}`);
  let record: unknown;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw ledgerBlocked(`open-operation marker malformed: ${operationId}`);
  }
  if (!isIdentityRecord(record) || record.operationId !== operationId || record.project !== projectId || record.outcome !== "in-progress") {
    throw ledgerBlocked(`open-operation marker invalid: ${operationId}`);
  }
  return { operationId, record };
}

/**
 * The operation id a ledger entry names: a regular `<safeId>.json` record,
 * decided first. `null` for the replacing writer's exact temp sibling, which is
 * skipped and left untouched. Any other entry refuses: it is never skipped.
 */
function ledgerEntryId(entry: { name: string; regular: boolean }, ledger: string): string | null {
  const operationId = entry.name.replace(/\.json$/u, "");
  if (entry.regular && entry.name.endsWith(".json") && isSafeRecordId(operationId)) return operationId;
  if (isReplacingRecordTemp(entry)) return null;
  throw ledgerBlocked(`${ledger} entry is not a record: ${entry.name}`);
}

/**
 * Every marker of the project. Any unreadable, nonregular or malformed entry
 * refuses the whole read (only an exact replacing-write temp sibling is
 * skipped), and so does a missing marker directory: adoption
 * establishes it, so its absence means the view was lost, not that it is empty.
 */
export async function readOpenMarkers(root: string, projectId: string): Promise<OpenMarker[]> {
  const entries = await listEntriesIfPresent(root, ledgerDir("open"));
  if (entries === null) {
    throw ledgerBlocked("the open-operation marker directory is missing; restore .llmwiki/portable/ledger/open from backup before any write");
  }
  const markers: OpenMarker[] = [];
  for (const entry of entries) {
    const operationId = ledgerEntryId(entry, "open-operation");
    if (operationId === null) continue;
    const bytes = await readProjectFile(root, ledgerFile("open", operationId), MAX_IDENTITY_BYTES).catch(() => null);
    markers.push(parseMarker(operationId, bytes, projectId));
  }
  return markers;
}

/** True when a marker's record holds nothing that its loss could release: no approval, ticket or live generation. */
export function holdsNoCustody(record: OperationIdentityRecordV1): boolean {
  return record.holds.approvalId === null && record.holds.ticketId === null && record.generationLease === null;
}

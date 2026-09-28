/**
 * Durable ownership of collateral embedding work across failed batch tails.
 * Record floor-approved link writes BEFORE applying them: a later failure or
 * process exit must not lose IDs just because links are already correct on retry.
 * Candidate snapshot keys let a subset/reordered retry recover its own work
 * without draining unrelated embedding backlog or other interrupted batches.
 * Rejecting a snapshot hands the work it keys to the embedding retry queue first.
 * Callers hold the project lock; malformed/oversize/unwritable intent fails closed.
 */
import path from "node:path";
import { z } from "zod";
import { sha256Text } from "../connectors/hash.js";
import { readConfinedLeaf } from "../utils/confined-read.js";
import { atomicWrite } from "../utils/markdown.js";
import { parseQualifiedPageId, type PageId } from "../utils/page-id.js";
import { resolveConfinedPrivateDir } from "../utils/private-dir.js";
import type { ReviewCandidate } from "../utils/types.js";

const INTENT_FILE = "review-embedding-intent.json";
const MAX_INTENT_BYTES = 1024 * 1024;
const intentSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(z.object({
    candidates: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
    pageIds: z.array(z.string().refine(id => parseQualifiedPageId(id) !== null)),
  })),
});
type IntentEntry = z.infer<typeof intentSchema>["entries"][number];
/** The candidate fields that identify one promoted snapshot. */
type SnapshotFields = Partial<Record<"id" | "slug" | "targetDirectory" | "targetEntityType" | "body", unknown>>;

/** One locked session retaining ownership of this batch's embedding work. */
export interface ReviewEmbeddingIntent {
  pageIds: Set<PageId>;
  record(pageIds: PageId[]): Promise<void>;
  clear(): Promise<void>;
}

/** Open only work owned by these exact candidate snapshots; preserve all other entries. */
export async function openReviewEmbeddingIntent(root: string, candidates: ReviewCandidate[]): Promise<ReviewEmbeddingIntent> {
  const directory = await resolveConfinedPrivateDir(root);
  const file = path.join(directory, INTENT_FILE);
  const entries = await readIntent(directory, file);
  const keys = candidates.map(snapshotKey);
  const selected = entries.filter(entry => entry.candidates.some(key => keys.includes(key)));
  const untouched = entries.filter(entry => !selected.includes(entry));
  const owned: IntentEntry = {
    candidates: [...new Set([...keys, ...selected.flatMap(entry => entry.candidates)])],
    pageIds: [...new Set(selected.flatMap(entry => entry.pageIds))],
  };
  const pageIds = new Set<PageId>(owned.pageIds);
  return {
    pageIds,
    /** Record before mutations, propagating failures rather than losing retry intent. */
    async record(additionalIds: PageId[]): Promise<void> {
      owned.pageIds = [...new Set([...owned.pageIds, ...additionalIds])];
      await persistIntent(directory, file, [...untouched, owned]);
      for (const id of additionalIds) pageIds.add(id);
    },
    /** Retire only this work after handing it to the normal embedding retry lifecycle. */
    async clear(): Promise<void> {
      await persistIntent(directory, file, untouched);
    },
  };
}

/**
 * Detach a rejected record from the intent entries its snapshot keys. The key
 * comes from the raw captured bytes, not admission, so a record that lost an
 * unrelated field still releases its work. Page IDs go to `handOff` (the normal
 * embedding retry path) before the intent is rewritten; entries still keyed by
 * other snapshots keep their IDs for those batches.
 */
export async function releaseRejectedIntent(
  root: string,
  recordBytes: Buffer,
  handOff: (pageIds: PageId[]) => Promise<void>,
): Promise<void> {
  const key = rawSnapshotKey(recordBytes);
  if (key === null) return;
  const directory = await resolveConfinedPrivateDir(root);
  const file = path.join(directory, INTENT_FILE);
  const entries = await readIntent(directory, file);
  const owning = entries.filter(entry => entry.candidates.includes(key));
  if (owning.length === 0) return;
  await handOff([...new Set(owning.flatMap(entry => entry.pageIds))]);
  const remaining = entries
    .map(entry => owning.includes(entry) ? { ...entry, candidates: entry.candidates.filter(k => k !== key) } : entry)
    .filter(entry => entry.candidates.length > 0);
  await persistIntent(directory, file, remaining);
}

/** Identify a candidate by the exact snapshot a batch promoted, so edits never inherit its work. */
function snapshotKey(candidate: SnapshotFields): string {
  return sha256Text(JSON.stringify([
    candidate.id, candidate.slug, candidate.targetDirectory, candidate.targetEntityType, candidate.body,
  ]));
}

/**
 * Key raw record bytes as batch admission would. Admission passes these fields
 * through unchanged except a non-string targetEntityType, which it drops.
 * Bytes that are not a JSON object can never have been admitted, so have no key.
 */
function rawSnapshotKey(bytes: Buffer): string | null {
  const record = parseJson(bytes.toString("utf8"));
  if (typeof record !== "object" || record === null || Array.isArray(record)) return null;
  const fields = record as SnapshotFields;
  const targetEntityType = typeof fields.targetEntityType === "string" ? fields.targetEntityType : undefined;
  return snapshotKey({ ...fields, targetEntityType });
}

/** Read a bounded, handle-bound regular leaf; never treat corrupt recovery data as empty. */
async function readIntent(directory: string, file: string): Promise<IntentEntry[]> {
  const read = await readConfinedLeaf(path.dirname(directory), file, directory, MAX_INTENT_BYTES);
  if (read.kind === "absent") return [];
  if (read.kind !== "ok") throw new Error("Review embedding intent unavailable; retry after repairing its storage.");
  const parsed = intentSchema.safeParse(parseJson(read.body));
  if (!parsed.success) throw new Error("Invalid review embedding intent; recovery cannot safely continue.");
  return parsed.data.entries;
}

/** Truncated JSON is invalid intent too; let the schema report it with the same refusal. */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Bound writes symmetrically with reads and leave the last durable intent intact on failure. */
async function persistIntent(directory: string, file: string, entries: IntentEntry[]): Promise<void> {
  const body = JSON.stringify({ schemaVersion: 1, entries });
  if (Buffer.byteLength(body, "utf8") > MAX_INTENT_BYTES) {
    throw new Error("Review embedding intent exceeds 1 MiB; finish interrupted batches before continuing.");
  }
  await atomicWrite(file, body, { confineRoot: path.dirname(directory) });
}

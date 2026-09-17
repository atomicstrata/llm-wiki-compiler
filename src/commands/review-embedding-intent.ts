/**
 * Durable ownership of collateral embedding work across failed batch tails.
 * Record floor-approved link writes BEFORE applying them: a later failure or
 * process exit must not lose IDs just because links are already correct on retry.
 * Candidate snapshot keys let a subset/reordered retry recover its own work
 * without draining unrelated embedding backlog or other interrupted batches.
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

/** Open only work owned by these exact candidate snapshots; preserve all other entries. */
export async function openReviewEmbeddingIntent(root: string, candidates: ReviewCandidate[]) {
  const directory = await resolveConfinedPrivateDir(root);
  const file = path.join(directory, INTENT_FILE);
  const entries = await readIntent(directory, file);
  const keys = candidates.map(candidate => sha256Text(JSON.stringify([
    candidate.id, candidate.slug, candidate.targetDirectory, candidate.targetEntityType, candidate.body,
  ])));
  const selected = entries.filter(entry => entry.candidates.some(key => keys.includes(key)));
  const untouched = entries.filter(entry => !selected.includes(entry));
  const owned: IntentEntry = {
    candidates: [...new Set([...keys, ...selected.flatMap(entry => entry.candidates)])],
    pageIds: [...new Set(selected.flatMap(entry => entry.pageIds))],
  };
  return {
    pageIds: new Set<PageId>(owned.pageIds),
    /** Record before mutations, propagating failures rather than losing retry intent. */
    async record(pageIds: PageId[]): Promise<void> {
      owned.pageIds = [...new Set([...owned.pageIds, ...pageIds])];
      await persistIntent(directory, file, [...untouched, owned]);
    },
    /** Retire only this work after handing it to the normal embedding retry lifecycle. */
    async clear(): Promise<void> {
      await persistIntent(directory, file, untouched);
    },
  };
}

/** Read a bounded, handle-bound regular leaf; never treat corrupt recovery data as empty. */
async function readIntent(directory: string, file: string): Promise<IntentEntry[]> {
  const read = await readConfinedLeaf(path.dirname(directory), file, directory, MAX_INTENT_BYTES);
  if (read.kind === "absent") return [];
  if (read.kind !== "ok") throw new Error("Review embedding intent unavailable; retry after repairing its storage.");
  const parsed = intentSchema.safeParse(JSON.parse(read.body));
  if (!parsed.success) throw new Error("Invalid review embedding intent; recovery cannot safely continue.");
  return parsed.data.entries;
}

/** Bound writes symmetrically with reads and leave the last durable intent intact on failure. */
async function persistIntent(directory: string, file: string, entries: IntentEntry[]): Promise<void> {
  const body = JSON.stringify({ schemaVersion: 1, entries });
  if (Buffer.byteLength(body, "utf8") > MAX_INTENT_BYTES) {
    throw new Error("Review embedding intent exceeds 1 MiB; finish interrupted batches before continuing.");
  }
  await atomicWrite(file, body, { confineRoot: path.dirname(directory) });
}

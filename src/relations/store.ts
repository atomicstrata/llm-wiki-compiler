/**
 * @file src/relations/store.ts
 * @description The WRITE half of the append-only relation store. Validates a
 * relation against its profile relation-type def, mints a stable `rel_<ULID>`
 * id, canonicalizes symmetric endpoints, and APPENDS the record (record +
 * checksum) under the project lock as a single writer. A new store gets a
 * header line first. The read half lives in `store-read.ts`.
 *
 * DURABILITY: appends use O_APPEND under {@link acquireLock}/{@link releaseLock}
 * so a single writer extends the file atomically (each line either lands whole
 * or, at worst, leaves a torn TRAILING line the reader tolerates and reports).
 * CONFINEMENT: the graph dir is resolved through {@link resolveGraphDir}, which
 * fails closed if `wiki/graph` is a symlink escaping root.
 *
 * UPDATE: because the store is append-only, {@link updateRelation} appends a
 * NEW record carrying the SAME `id` with a recomputed `contentHash`. The reader
 * returns the latest record per id, so the prior record is superseded while
 * staying on disk for audit. Changing `type`/`from`/`to` is a delete+create
 * (a different edge) and is NOT an update — callers pass only attributes/evidence.
 */

import { open, mkdir } from "fs/promises";
import path from "path";
import { RELATIONS_FILE } from "../utils/constants.js";
import { acquireLock, releaseLock } from "../utils/lock.js";
import { parseEntityId } from "../profile/identity.js";
import type { EntityId, ProfilePack, RelationTypeDef } from "../profile/types.js";
import type { CitationRef, RelationRef } from "./types.js";
import { RelationEndpointError } from "./types.js";
import { mintRelationId } from "./ulid.js";
import { canonicalEndpoints, relationContentHash } from "./digest.js";
import { headerLine, serializeRecord, resolveGraphDir } from "./store-record.js";
import { readRelations } from "./store-read.js";

/** The caller-supplied content of a new relation (id + hash are derived). */
export interface AppendRelationInput {
  type: string;
  from: EntityId;
  to: EntityId;
  attributes?: Record<string, unknown>;
  evidence?: CitationRef[];
}

/** An in-place attribute/evidence patch applied under an existing relation id. */
export interface UpdateRelationPatch {
  attributes?: Record<string, unknown>;
  evidence?: CitationRef[];
}

/** Look up a relation-type def, failing closed if the type is undeclared. */
function relationDef(profile: ProfilePack, type: string): RelationTypeDef {
  const def = profile.relations?.[type];
  if (!def) {
    throw new RelationEndpointError(`unknown relation type '${type}'`);
  }
  return def;
}

/** Assert one endpoint's entity type is allowed on its side of the relation. */
function assertEndpoint(id: EntityId, allowed: string[], side: "from" | "to", type: string): void {
  const { entityType } = parseEntityId(id);
  if (!allowed.includes(entityType)) {
    throw new RelationEndpointError(
      `relation '${type}' ${side} endpoint type '${entityType}' is not allowed (expected one of ${allowed.join(", ")})`,
    );
  }
}

/** Assert every required attribute of the relation type is present in `attributes`. */
function assertRequiredAttributes(def: RelationTypeDef, attributes: Record<string, unknown>, type: string): void {
  for (const name of def.requiredAttributes ?? []) {
    if (!(name in attributes)) {
      throw new RelationEndpointError(`relation '${type}' is missing required attribute '${name}'`);
    }
  }
}

/**
 * Validate endpoints + required attributes against the relation-type def, then
 * build the {@link RelationRef}: canonicalize symmetric endpoints, mint the id
 * (or reuse `existingId` for an update), and compute the content hash. NOTHING
 * is written here — validation throwing leaves the store untouched.
 */
function buildRelationRef(
  profile: ProfilePack,
  input: AppendRelationInput,
  existingId?: RelationRef["id"],
): RelationRef {
  const def = relationDef(profile, input.type);
  assertEndpoint(input.from, def.from, "from", input.type);
  assertEndpoint(input.to, def.to, "to", input.type);
  const attributes = input.attributes ?? {};
  assertRequiredAttributes(def, attributes, input.type);
  const { from, to } = canonicalEndpoints(input.from, input.to, def.direction);
  const content = { type: input.type, from, to, attributes, evidence: input.evidence };
  return { id: existingId ?? mintRelationId(), ...content, contentHash: relationContentHash(content) };
}

/** Append one serialized record line to the store under O_APPEND, creating the dir/header. */
async function appendLine(root: string, ref: RelationRef): Promise<void> {
  const { dir } = await resolveGraphDir(root); // throws on symlink escape
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, path.basename(RELATIONS_FILE));
  const handle = await open(file, "a");
  try {
    if ((await handle.stat()).size === 0) {
      await handle.write(headerLine());
    }
    await handle.write(serializeRecord(ref));
  } finally {
    await handle.close();
  }
}

/** Run `fn` while holding the project lock; release in a finally. */
async function underLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  if (!(await acquireLock(root))) {
    throw new Error("could not acquire project lock for relation store write");
  }
  try {
    return await fn();
  } finally {
    await releaseLock(root);
  }
}

/**
 * Validate and APPEND a new relation WHILE THE CALLER ALREADY HOLDS the project
 * lock — the lock-free core shared with {@link appendRelation}, mirroring the
 * {@link applyApprovedMutationsLocked} split on the page path.
 *
 * The caller MUST already hold the project lock; this function acquires NOTHING,
 * so a planner-routed write path ({@link createRelation}) can take ONE lock and
 * run validation + append inside it without a nested-acquire deadlock. Validation
 * (endpoint entity types, required attributes) still runs BEFORE any write, so a
 * violation throws {@link RelationEndpointError} and writes nothing.
 *
 * @param root - Absolute project root.
 * @param profile - The governing profile pack (its `relations` block is the schema).
 * @param input - The new relation's content.
 * @returns The persisted relation reference.
 */
export async function appendRelationLocked(
  root: string,
  profile: ProfilePack,
  input: AppendRelationInput,
): Promise<RelationRef> {
  const ref = buildRelationRef(profile, input); // throws before any write
  await appendLine(root, ref);
  return ref;
}

/**
 * Validate and APPEND a new relation, returning its {@link RelationRef}.
 *
 * The self-locking entry point for callers that do NOT already hold the lock:
 * acquires the project lock and delegates to {@link appendRelationLocked}.
 * Validation (endpoint entity types, required attributes) runs BEFORE any
 * write, so a violation throws {@link RelationEndpointError} and writes nothing.
 * The id is minted once; symmetric endpoints are canonicalized so (a→b) and
 * (b→a) share a content hash. The append occurs under the project lock.
 *
 * @param root - Absolute project root.
 * @param profile - The governing profile pack (its `relations` block is the schema).
 * @param input - The new relation's content.
 * @returns The persisted relation reference.
 */
export async function appendRelation(
  root: string,
  profile: ProfilePack,
  input: AppendRelationInput,
): Promise<RelationRef> {
  return underLock(root, () => appendRelationLocked(root, profile, input));
}

/**
 * Apply an in-place attribute/evidence update to an existing relation. Appends
 * a new record carrying the SAME `id` with a recomputed `contentHash`; the
 * reader returns the latest record per id, so this supersedes the prior one.
 * The relation's `type`/`from`/`to` are preserved from the existing record.
 *
 * @param root - Absolute project root.
 * @param profile - The governing profile pack.
 * @param id - The id of the relation to update.
 * @param patch - The attribute/evidence patch to apply.
 * @returns The updated relation reference (same id, new content hash).
 */
export async function updateRelation(
  root: string,
  profile: ProfilePack,
  id: RelationRef["id"],
  patch: UpdateRelationPatch,
): Promise<RelationRef> {
  const { relations } = await readRelations(root);
  const existing = relations.find((rel) => rel.id === id);
  if (!existing) {
    throw new RelationEndpointError(`no relation with id '${id}' to update`);
  }
  const input: AppendRelationInput = {
    type: existing.type,
    from: existing.from,
    to: existing.to,
    attributes: patch.attributes ?? existing.attributes,
    evidence: patch.evidence ?? existing.evidence,
  };
  const ref = buildRelationRef(profile, input, id);
  await underLock(root, () => appendLine(root, ref));
  return ref;
}

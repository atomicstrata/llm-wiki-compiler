/**
 * @file src/compiler/candidate-publication.ts
 * @description Shared bounded collision-exclusive publisher for every newly
 * allocated review candidate identity. It validates the first identity before
 * store access, checks literal pending/archive ownership, and commits pending
 * bytes through the candidate no-replace primitive.
 *
 * THE ALLOCATOR HAS ONE BODY, {@link publishFreshCandidateFrom}, over the raw
 * effects of {@link CandidatePublicationStore}. The domain stays here: identity
 * minting and validation, the sixteen-attempt bound, which namespaces are
 * consulted and in what order, the archive recheck at the publication boundary,
 * and what each failure means (a collision retries, an unsafe directory passes
 * through, any other fault is the fixed publication refusal). The store's
 * members are raw effects or named MECHANISMS: the candidate-store namespace
 * identity check (custody), directory confinement and the atomic no-replace
 * publish. Their disk forms are {@link diskCandidatePublicationStore}.
 */

import { randomBytes } from "node:crypto";
import { AtomicWriteCollisionError } from "../utils/atomic-write.js";
import { CANDIDATES_ARCHIVE_DIR, CANDIDATES_DIR } from "../utils/constants.js";
import {
  candidateNamespacesHealthyFrom,
  diskCandidateCustodyReads,
  type CandidateStoreWriteReads,
} from "./candidate-custody.js";
import { assertCandidateSlug, assertWritableCandidateId } from "./candidate-paths.js";
import { assertCandidateIdsWritable } from "./candidate-selection.js";
import { UnsafeCandidateDirError } from "./candidate-store-paths.js";

/** Bytes of random suffix appended to generated candidate IDs. */
const ID_SUFFIX_BYTES = 4;

/** Maximum identities attempted for one fresh publication. */
const MAX_FRESH_CANDIDATE_ATTEMPTS = 16;

/** Test seams for deterministic identity and commit-point coverage. */
export interface FreshCandidateWriteOptions {
  idForAttemptForTest?: (slug: string, attempt: number) => string;
  beforePublishForTest?: (candidateId: string, attempt: number) => Promise<void>;
  afterPublishForTest?: () => Promise<void>;
}

/** Fixed refusal after all fresh identities collide. */
export class FreshCandidateIdExhaustedError extends Error {
  constructor() {
    super("fresh candidate identity allocation exhausted");
    this.name = "FreshCandidateIdExhaustedError";
  }
}

/** Fixed typed refusal for an unclassified publication failure. */
export class CandidatePublicationUnavailableError extends Error {
  constructor() {
    super("candidate publication is unavailable");
    this.name = "CandidatePublicationUnavailableError";
  }
}

/** The two points at which the caller's hooks run around one exclusive create. */
interface CandidateCreateHooks {
  /** Runs after the parent check and before the commit. Rejects to abort the create. */
  readonly afterParentCheck: () => Promise<void>;
  /** Runs after the leaf has been committed. */
  readonly afterCommit?: () => Promise<void>;
}

/** Where the two owned namespaces are, as one health check just proved them (`null` = absent). */
export interface CandidateOwnedDirectories {
  readonly pending: string | null;
  readonly archive: string | null;
}

/**
 * The raw candidate-store effects the fresh allocator runs over. Each member
 * rejects with its own error; the allocator decides what that error means.
 */
export interface CandidatePublicationStore {
  /**
   * MECHANISM (candidate-store custody: namespace identity). Resolves, with the
   * real directory of each namespace it bound, when each owned namespace that
   * exists is readable and the two are distinct objects; rejects otherwise.
   */
  assertNamespacesHealthy(): Promise<CandidateOwnedDirectories>;
  /**
   * MECHANISM (directory confinement). Where the owned directory `relDir` is,
   * or `null` when it is absent. Rejects with `UnsafeCandidateDirError` when
   * it escapes the project or is not a directory.
   */
  ownedDirectory(relDir: string): Promise<string | null>;
  /** RAW. Whether anything, a link included, is at `<dir>/<leafName>`. Rejects with the raw fault. */
  leafPresent(dir: string, leafName: string): Promise<boolean>;
  /**
   * MECHANISM (confined, atomic, no-replace publish). Resolve the pending leaf
   * of `id` under the project, then create it with `text` without ever
   * replacing an existing leaf: an occupied leaf, or a hook rejection, rejects.
   */
  createPending(id: string, text: string, hooks: CandidateCreateHooks): Promise<void>;
}

/**
 * The publication store composed from the store mechanisms: the namespace
 * policy is the shared domain body ({@link candidateNamespacesHealthyFrom}),
 * the owned directory is the alias-tolerant binding's real directory, and the
 * exclusive create resolves the confined pending leaf first. Building it does no I/O.
 */
export function candidatePublicationStoreFrom(reads: CandidateStoreWriteReads): CandidatePublicationStore {
  return {
    assertNamespacesHealthy: async () => {
      const proven = await candidateNamespacesHealthyFrom(reads);
      return { pending: proven.pending?.realDir ?? null, archive: proven.archive?.realDir ?? null };
    },
    ownedDirectory: async (relDir) => (await reads.captureDirectory(relDir))?.realDir ?? null,
    leafPresent: (dir, leafName) => reads.leafPresent(dir, leafName),
    createPending: async (id, text, hooks) => {
      await reads.createLeaf(await reads.leafPath(id, "pending"), text, hooks);
    },
  };
}

/** LOCAL DISK. {@link candidatePublicationStoreFrom} over the project at `root`. In no package index. */
export function diskCandidatePublicationStore(root: string): CandidatePublicationStore {
  return candidatePublicationStoreFrom(diskCandidateCustodyReads(root));
}

/** Candidate plus its already-materialized serialized authority. */
export interface CandidatePublication<T> {
  readonly candidate: T;
  readonly serialized: string;
}

/** Build the normal random slug-derived identity. */
function randomCandidateId(slug: string): string {
  return `${slug}-${randomBytes(ID_SUFFIX_BYTES).toString("hex")}`;
}

/** Mint and validate one attempt identity before any filesystem access. */
export function writableCandidateId(
  slug: string,
  attempt: number,
  options: FreshCandidateWriteOptions,
): string {
  assertCandidateSlug(slug);
  const id = options.idForAttemptForTest?.(slug, attempt) ?? randomCandidateId(slug);
  assertCandidateIdsWritable([id]);
  assertWritableCandidateId(id);
  return id;
}

/** True when one exact no-follow leaf already owns an identity. */
async function candidateObjectExists(store: CandidatePublicationStore, dir: string, id: string): Promise<boolean> {
  return candidateLeafPresent(store, await store.ownedDirectory(dir), id);
}

/** True when the exact no-follow leaf of `id` is in an owned directory already located (`null` = absent). */
async function candidateLeafPresent(store: CandidatePublicationStore, ownedDir: string | null, id: string): Promise<boolean> {
  if (ownedDir === null) return false;
  try {
    return await store.leafPresent(ownedDir, `${id}.json`);
  } catch {
    throw new CandidatePublicationUnavailableError();
  }
}

/**
 * True when pending or archive already owns the exact identity. The health
 * check binds both namespaces and its probes re-prove each binding right after
 * checking access, so the existence looks use the directories it hands back
 * rather than binding them again. This lookup only skips a taken identity
 * early: exclusion itself is the no-replace create and the archive recheck
 * at the publication boundary, which binds archive afresh.
 */
async function candidateIdentityExists(store: CandidatePublicationStore, id: string): Promise<boolean> {
  const owned = await store.assertNamespacesHealthy();
  return (await candidateLeafPresent(store, owned.pending, id)) ||
    (await candidateLeafPresent(store, owned.archive, id));
}

/** Publish one attempt, translating only non-confinement I/O faults. */
async function publishAttempt(
  store: CandidatePublicationStore,
  publication: CandidatePublication<unknown>,
  id: string,
  attempt: number,
  options: FreshCandidateWriteOptions,
): Promise<void> {
  try {
    await store.createPending(id, publication.serialized, {
      afterParentCheck: async () => {
        await options.beforePublishForTest?.(id, attempt);
        if (await candidateObjectExists(store, CANDIDATES_ARCHIVE_DIR, id)) {
          throw new AtomicWriteCollisionError();
        }
      },
      afterCommit: options.afterPublishForTest,
    });
  } catch (error) {
    if (error instanceof AtomicWriteCollisionError || error instanceof UnsafeCandidateDirError) {
      throw error;
    }
    throw new CandidatePublicationUnavailableError();
  }
}

/**
 * Publish a new identity using at most sixteen collision-exclusive attempts, over
 * a publication store: THE ONE BODY (the disk store is
 * {@link diskCandidatePublicationStore}). `firstId` must have been minted before
 * any caller-side store scan.
 */
export async function publishFreshCandidateFrom<T>(
  store: CandidatePublicationStore,
  slug: string,
  firstId: string,
  materialize: (id: string) => CandidatePublication<T>,
  options: FreshCandidateWriteOptions,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_FRESH_CANDIDATE_ATTEMPTS; attempt += 1) {
    const id = attempt === 0 ? firstId : writableCandidateId(slug, attempt, options);
    const publication = materialize(id);
    if (await candidateIdentityExists(store, id)) continue;
    try {
      await publishAttempt(store, publication, id, attempt, options);
      return publication.candidate;
    } catch (error) {
      if (error instanceof AtomicWriteCollisionError) continue;
      throw error;
    }
  }
  throw new FreshCandidateIdExhaustedError();
}

/**
 * @file src/compiler/candidate-publication.ts
 * @description Shared bounded collision-exclusive publisher for every newly
 * allocated review candidate identity. It validates the first identity before
 * store access, checks literal pending/archive ownership, and commits pending
 * bytes through the candidate no-replace primitive.
 */

import { randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  AtomicWriteCollisionError,
  atomicWriteNoReplace,
} from "../utils/atomic-write.js";
import { CANDIDATES_ARCHIVE_DIR, CANDIDATES_DIR } from "../utils/constants.js";
import { assertCandidateNamespacesHealthy } from "./candidate-custody.js";
import { assertCandidateSlug, assertWritableCandidateId, candidatePath } from "./candidate-paths.js";
import { assertCandidateIdsWritable } from "./candidate-selection.js";
import { resolveConfinedCandidatesDir, UnsafeCandidateDirError } from "./candidate-store-paths.js";

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
async function candidateObjectExists(root: string, dir: string, id: string): Promise<boolean> {
  const ownedDir = await resolveConfinedCandidatesDir(root, dir);
  if (ownedDir === null) return false;
  try {
    await lstat(path.join(ownedDir, `${id}.json`));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new CandidatePublicationUnavailableError();
  }
}

/** True when pending or archive already owns the exact identity. */
async function candidateIdentityExists(root: string, id: string): Promise<boolean> {
  await assertCandidateNamespacesHealthy(root);
  return (await candidateObjectExists(root, CANDIDATES_DIR, id)) ||
    (await candidateObjectExists(root, CANDIDATES_ARCHIVE_DIR, id));
}

/** Publish one attempt, translating only non-confinement I/O faults. */
async function publishAttempt(
  root: string,
  publication: CandidatePublication<unknown>,
  id: string,
  attempt: number,
  options: FreshCandidateWriteOptions,
): Promise<void> {
  try {
    await atomicWriteNoReplace(await candidatePath(root, id), publication.serialized, {
      confineRoot: await realpath(root),
      afterParentCheckForTest: async () => {
        await options.beforePublishForTest?.(id, attempt);
        if (await candidateObjectExists(root, CANDIDATES_ARCHIVE_DIR, id)) {
          throw new AtomicWriteCollisionError();
        }
      },
      afterNoReplaceCommitForTest: options.afterPublishForTest,
    });
  } catch (error) {
    if (error instanceof AtomicWriteCollisionError || error instanceof UnsafeCandidateDirError) {
      throw error;
    }
    throw new CandidatePublicationUnavailableError();
  }
}

/**
 * Publish a new identity using at most sixteen collision-exclusive attempts.
 * `firstId` must have been minted before any caller-side store scan.
 */
export async function publishFreshCandidate<T>(
  root: string,
  slug: string,
  firstId: string,
  materialize: (id: string) => CandidatePublication<T>,
  options: FreshCandidateWriteOptions,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_FRESH_CANDIDATE_ATTEMPTS; attempt += 1) {
    const id = attempt === 0 ? firstId : writableCandidateId(slug, attempt, options);
    const publication = materialize(id);
    if (await candidateIdentityExists(root, id)) continue;
    try {
      await publishAttempt(root, publication, id, attempt, options);
      return publication.candidate;
    } catch (error) {
      if (error instanceof AtomicWriteCollisionError) continue;
      throw error;
    }
  }
  throw new FreshCandidateIdExhaustedError();
}

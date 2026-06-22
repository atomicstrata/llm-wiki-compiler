/**
 * @file src/trust/lifecycle-transition.ts
 * @description The trust-gated LIFECYCLE TRANSITION entry point, shared by the
 * SDK and CLI.
 *
 * A lifecycle transition is NOT a new executor kind — it is a validated PAGE
 * UPDATE. PR2 already enforces the lifecycle gate ({@link validateLifecycleTransition})
 * on any typed page write, so {@link transitionLifecycle} is a thin, correctly
 * gated READ-MODIFY-WRITE: it reads the existing `wiki/<entityType>/<slug>.md`,
 * sets its lifecycle field to `toState` (merging any required `evidence` into the
 * frontmatter), and re-writes the page through the EXISTING typed promotion path
 * ({@link applyTypedCandidate}). That path re-runs the PR2 lifecycle gate, so an
 * illegal transition (or one missing required evidence) is REFUSED there and the
 * page is left unchanged — no separate validation is duplicated here.
 *
 * Because the write rides the existing page executor + journal, this destabilizes
 * NOTHING: the page bytes land atomically exactly as a typed promotion does.
 */

import { loadNonDefaultProfile } from "../profile/block.js";
import { resolveConfinedEntityPage } from "../profile/lifecycle-read.js";
import { parseFrontmatter, buildFrontmatter, safeReadFile } from "../utils/markdown.js";
import { acquireLock, releaseLock } from "../utils/lock.js";
import { appendEventLocked } from "../events/store.js";
import { applyTypedCandidate } from "./promote.js";
import type { EntityTypeDef } from "../profile/types.js";
import type { ReviewCandidate } from "../utils/types.js";

/** Optional evidence fields merged into the page frontmatter for the transition. */
export type LifecycleEvidence = Record<string, unknown>;

/**
 * Thrown when a lifecycle transition is requested for an entity type that has NO
 * declared lifecycle, or whose page does not exist. Fails CLOSED before any write
 * so a transition is only ever attempted against a real, lifecycle-bearing page.
 */
export class LifecycleTransitionUnavailableError extends Error {
  constructor(reason: "no-profile" | "unknown-type" | "no-lifecycle" | "no-page", detail: string) {
    super(`cannot transition lifecycle: ${detail}`);
    this.name = "LifecycleTransitionUnavailableError";
    void reason;
  }
}

/**
 * Thrown when {@link transitionLifecycle} cannot acquire the project lock —
 * another process is writing this project. The transition is a read-modify-write,
 * so it MUST run single-writer; without the lock the prev-state read and the
 * apply could race (TOCTOU) and corrupt the journal. Fails CLOSED, writing nothing.
 */
export class LifecycleTransitionLockError extends Error {
  constructor() {
    super("cannot transition lifecycle: another llmwiki process is using this project (lock held)");
    this.name = "LifecycleTransitionLockError";
  }
}

/** Resolve the entity def, failing closed when the profile/type/lifecycle is absent. */
async function resolveLifecycleDef(root: string, entityType: string): Promise<EntityTypeDef> {
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) throw new LifecycleTransitionUnavailableError("no-profile", "the project has no non-default profile");
  const def = loaded.profile.entities[entityType];
  if (!def) {
    throw new LifecycleTransitionUnavailableError("unknown-type", `the profile does not declare entity type "${entityType}"`);
  }
  if (!def.lifecycle) {
    throw new LifecycleTransitionUnavailableError("no-lifecycle", `entity type "${entityType}" has no declared lifecycle`);
  }
  return def;
}

/** Read the existing page body (path-confined), failing closed when it is absent. */
async function readExistingPage(root: string, def: EntityTypeDef, slug: string): Promise<string> {
  const real = await resolveConfinedEntityPage(root, def, slug);
  if (real === null) {
    throw new LifecycleTransitionUnavailableError("no-page", `no page at ${def.directory}/${slug}.md to transition`);
  }
  return safeReadFile(real);
}

/** Frontmatter keys a transition's `evidence` may NEVER set, even if declared. */
const RESERVED_EVIDENCE_KEYS: ReadonlySet<string> = new Set(["slug"]);

/**
 * Reduce caller-supplied `evidence` to ONLY the keys that are legitimately
 * settable for THIS transition: the fields the entity's lifecycle declares as
 * `transitionRequirements[toState]`, MINUS any reserved identity key. Any key the
 * caller passes that is not a declared evidence field for the target state — a
 * `title` clobber, a planted `slug`, arbitrary junk — is DROPPED (FIX #2). When
 * the target state declares no requirements, NO evidence key is admitted.
 *
 * @param def - The (lifecycle-bearing) entity type definition.
 * @param toState - The lifecycle state being transitioned into.
 * @param evidence - The caller-supplied, untrusted evidence map.
 * @returns Only the declared, non-reserved evidence key/value pairs.
 */
function allowedEvidence(def: EntityTypeDef, toState: string, evidence?: LifecycleEvidence): LifecycleEvidence {
  const declared = def.lifecycle!.transitionRequirements?.[toState] ?? [];
  const allowed: LifecycleEvidence = {};
  for (const field of declared) {
    if (RESERVED_EVIDENCE_KEYS.has(field)) continue;
    if (evidence && Object.prototype.hasOwnProperty.call(evidence, field)) allowed[field] = evidence[field];
  }
  return allowed;
}

/**
 * Build the new page body for the transition: parse the existing body, set the
 * lifecycle field to `toState`, merge ONLY the ALLOW-LISTED `evidence` fields
 * (those declared as required for `toState`; see {@link allowedEvidence}) into the
 * frontmatter, and re-assemble `${buildFrontmatter(meta)}\n${body}` (the project's
 * standard page assembly). The prose body is preserved verbatim. The lifecycle
 * `field` is written LAST so it always wins, and arbitrary caller keys
 * (`title`/`slug`/junk) can never clobber existing frontmatter (FIX #2).
 */
function buildTransitionedBody(
  existing: string,
  def: EntityTypeDef,
  toState: string,
  evidence?: LifecycleEvidence,
): string {
  const { meta, body } = parseFrontmatter(existing);
  const nextMeta = { ...meta, ...allowedEvidence(def, toState, evidence), [def.lifecycle!.field]: toState };
  return `${buildFrontmatter(nextMeta)}\n${body}`;
}

/**
 * The read-modify-write core of a transition, run WHILE THE CALLER ALREADY HOLDS
 * the project lock. Reads the existing page + its prev lifecycle state, rewrites
 * the lifecycle field (+ any `evidence`), and applies through the LOCK-FREE
 * {@link applyTypedCandidate} (correct now that we hold the lock). Because the
 * prev-state read and the apply both run under the one held lock, no concurrent
 * writer can race between them.
 *
 * @param root - Absolute project root.
 * @param entityType - The profile entity type whose page is transitioned.
 * @param def - The resolved (lifecycle-bearing) entity type definition.
 * @param slug - The page slug (the filename stem).
 * @param toState - The lifecycle state to transition the page into.
 * @param evidence - Optional frontmatter fields a target state requires (merged in).
 */
async function transitionUnderLock(
  root: string,
  entityType: string,
  def: EntityTypeDef,
  slug: string,
  toState: string,
  evidence?: LifecycleEvidence,
): Promise<void> {
  const existing = await readExistingPage(root, def, slug);
  const prev = parseFrontmatter(existing).meta[def.lifecycle!.field];
  const body = buildTransitionedBody(existing, def, toState, evidence);
  const candidate: Pick<ReviewCandidate, "slug" | "body" | "targetEntityType"> = {
    slug,
    body,
    targetEntityType: entityType,
  };
  await applyTypedCandidate(root, candidate as ReviewCandidate);
  // Emit AFTER the page write lands, under the held lock so event + mutation
  // co-commit. Best-effort: a failed emit does not roll back the transition.
  await emitTransitionEvent(root, { entityType, slug, prev, toState, evidence });
}

/** The fields one lifecycle-transition audit event records about the transition. */
interface TransitionEventFields {
  entityType: string;
  slug: string;
  prev: unknown;
  toState: string;
  evidence?: LifecycleEvidence;
}

/**
 * Emit one `lifecycle-transition` audit event into the chained event store under
 * the CALLER's held lock (the lock-free {@link appendEventLocked}). Called only
 * after {@link applyTypedCandidate} has durably written the page, so the event
 * trails the mutation it records.
 */
async function emitTransitionEvent(root: string, fields: TransitionEventFields): Promise<void> {
  await appendEventLocked(root, {
    type: "lifecycle-transition",
    origin: "sdk",
    payload: {
      entityType: fields.entityType,
      slug: fields.slug,
      from: fields.prev ?? null,
      to: fields.toState,
      evidenceKeys: Object.keys(fields.evidence ?? {}),
    },
    at: new Date().toISOString(),
  });
}

/**
 * Transition a typed entity page's lifecycle field to `toState` as a validated
 * page update, UNDER THE PROJECT LOCK. Resolves the entity def (throwing
 * {@link LifecycleTransitionUnavailableError} when the type has no lifecycle),
 * acquires the project lock (throwing {@link LifecycleTransitionLockError} when
 * another process holds it), then INSIDE the lock reads the existing page,
 * rewrites its lifecycle field (+ any `evidence`), and applies the new body
 * through {@link applyTypedCandidate} — which RE-RUNS the PR2 lifecycle gate, so
 * an illegal transition or one missing required evidence is REFUSED there
 * (`LifecycleTransitionError` propagates) and the page is left unchanged. The
 * lock makes the prev-state read and the apply atomic (no TOCTOU); it is always
 * released in `finally`.
 *
 * @param root - Absolute project root.
 * @param entityType - The profile entity type whose page is transitioned.
 * @param slug - The page slug (the filename stem).
 * @param toState - The lifecycle state to transition the page into.
 * @param evidence - Optional frontmatter fields a target state requires (merged in).
 * @throws {LifecycleTransitionUnavailableError} When no profile/type/lifecycle/page.
 * @throws {LifecycleTransitionLockError} When the project lock cannot be acquired.
 * @throws {LifecycleTransitionError} When the PR2 gate refuses the transition.
 */
export async function transitionLifecycle(
  root: string,
  entityType: string,
  slug: string,
  toState: string,
  evidence?: LifecycleEvidence,
): Promise<void> {
  const def = await resolveLifecycleDef(root, entityType);
  if (!(await acquireLock(root))) throw new LifecycleTransitionLockError();
  try {
    await transitionUnderLock(root, entityType, def, slug, toState, evidence);
  } finally {
    await releaseLock(root);
  }
}

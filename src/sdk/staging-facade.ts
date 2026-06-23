/**
 * @file src/sdk/staging-facade.ts
 * @description The EXPERIMENTAL non-default staging slice of the `Wiki` facade,
 * factored out of `src/sdk/wiki.ts` so the high-fan-in facade module stays lean.
 *
 * Both methods run silently under the caller-supplied quiet wrapper and load the
 * active non-default profile INTERNALLY — the consumer never passes a
 * `ProfilePack`. They delegate to the trust-layer staging helpers, which fail
 * CLOSED (`StagingRequiresProfileError`) on a project with no non-default profile.
 *
 * The facade emits NO stdout note (it runs quiet by contract); the
 * read-integration status — typed pages are surfaced in `status`, the JSON
 * export, the wiki INDEX, the viewer graph, and agent context packs (lexical
 * ranking + relation-edge expansion); typed-page semantic search is deferred —
 * is documented on the `stageEntityPage`/`promoteStagedPage` method docstrings instead.
 *
 * @experimental Foundation API — the shape may change in a future minor release.
 */

import { stageEntityPageForProject, promoteStagedEntityPage } from "../trust/staging.js";
import { createRelationForProject } from "../trust/relation-write.js";
import { transitionLifecycle } from "../trust/lifecycle-transition.js";
import type { Wiki } from "./types.js";

/** The experimental non-default methods the `Wiki` facade composes in. */
export type StagingFacadeSlice = Pick<
  Wiki,
  "stageEntityPage" | "promoteStagedPage" | "createRelation" | "transitionLifecycle"
>;

/**
 * Build the experimental non-default slice of the `Wiki` facade bound to `root`:
 * page staging/promotion plus the trust-gated relation-write and lifecycle-
 * transition APIs. Each loads the active non-default profile INTERNALLY (the
 * consumer passes no `ProfilePack`) and fails CLOSED on a default project.
 *
 * @param root - Normalized absolute project root.
 * @param runQuiet - The facade's quiet-scoping wrapper (output suppressed).
 * @returns The experimental non-default Wiki methods.
 */
export function buildStagingFacade(
  root: string,
  runQuiet: <T>(fn: () => Promise<T>) => Promise<T>,
): StagingFacadeSlice {
  return {
    stageEntityPage: (input) => runQuiet(() => stageEntityPageForProject(root, input)),
    promoteStagedPage: (candidateId) => runQuiet(() => promoteStagedEntityPage(root, candidateId)),
    createRelation: (input) => runQuiet(() => createRelationForProject(root, input)),
    transitionLifecycle: (input) =>
      runQuiet(() => transitionLifecycle(root, input.entityType, input.slug, input.toState, input.evidence)),
  };
}

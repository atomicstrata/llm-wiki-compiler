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
 * @experimental Foundation API — the shape may change in a future minor release.
 */

import { stageEntityPageForProject, promoteStagedEntityPage } from "../trust/staging.js";
import type { Wiki } from "./types.js";

/** The experimental staging methods the `Wiki` facade composes in. */
export type StagingFacadeSlice = Pick<Wiki, "stageEntityPage" | "promoteStagedPage">;

/**
 * Build the experimental staging slice of the `Wiki` facade bound to `root`.
 *
 * @param root - Normalized absolute project root.
 * @param runQuiet - The facade's quiet-scoping wrapper (output suppressed).
 * @returns The `stageEntityPage` / `promoteStagedPage` methods.
 */
export function buildStagingFacade(
  root: string,
  runQuiet: <T>(fn: () => Promise<T>) => Promise<T>,
): StagingFacadeSlice {
  return {
    stageEntityPage: (input) => runQuiet(() => stageEntityPageForProject(root, input)),
    promoteStagedPage: (candidateId) => runQuiet(() => promoteStagedEntityPage(root, candidateId)),
  };
}

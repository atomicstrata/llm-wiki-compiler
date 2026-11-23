/**
 * @file src/trust/content-floor.ts
 * @description The PATH-FREE part of the mandatory page floor: the checks that
 * depend only on a page's identity and bytes, never on where a project lives.
 *
 * The planner and the page-apply primitive both run the floor against a project
 * root, because on disk a target must also be confined and collision-probed.
 * Those two checks are storage concerns. The remaining checks — safe identity,
 * the resource cap and a parseable frontmatter block — are the same question on
 * any backend, so they live here once and are called from three places: the
 * planner (through its mandatory checks), the page-apply primitive at the
 * byte-writing boundary, and a host that publishes to a store with no paths.
 * A page allowed here is allowed by the same code that guards a local compile.
 */

import { isSafeFilenameComponent } from "../profile/identity.js";
import { checkFrontmatter, checkResourceLimit, resourceCapForOrigin } from "./checks.js";
import { composeTrustDecision, type TrustCheckResult, type TrustDecision } from "./decision.js";

/** Decisions under which page bytes may be written. */
const WRITE_ALLOWED_DECISIONS: ReadonlySet<TrustDecision> = new Set(["allow", "allow-with-warning"]);

/** One page to judge, described without any filesystem location. */
export interface ContentFloorInput {
  /** The bare wiki namespace, for example `concepts`. */
  directory: string;
  /** The page slug stem, with no extension. */
  slug: string;
  /** The full markdown that would be written. */
  body: string;
  /** The origin that selects the resource cap, as the planner uses it. */
  origin: string;
  /** Character length of the page being replaced; raises the cap for a no-growth rewrite. */
  existingChars?: number;
}

/** The composed floor verdict with the checks that produced it. */
export interface ContentFloorResult {
  allowed: boolean;
  decision: TrustDecision;
  checks: TrustCheckResult[];
}

/**
 * The default-page identity floor: both components must be safe filename
 * components, so a slug can never name a different location once joined.
 */
export function checkDefaultIdentitySafe(directory: string, slug: string): TrustCheckResult {
  const code = "invalid-identity";
  if (isSafeFilenameComponent(directory) && isSafeFilenameComponent(slug)) {
    return { code, verdict: "pass", message: "directory and slug are safe filename components" };
  }
  return { code, verdict: "block", message: `directory/slug is not a safe filename component: ${directory}/${slug}` };
}

/**
 * The byte-only floor checks: resource cap and frontmatter shape. Shared by the
 * page-apply primitive so the disk path and a path-free host cannot drift.
 */
export async function runContentChecks(body: string, maxBodyChars: number): Promise<TrustCheckResult[]> {
  const ctx = { root: "", targetPath: "", body, maxBodyChars };
  return Promise.all([checkResourceLimit(ctx), checkFrontmatter(ctx)]);
}

/**
 * Run the whole path-free floor for one default page and compose its decision.
 *
 * @param input - The page identity, bytes, origin and any replaced length.
 * @returns Whether the page may be written, with the composed decision.
 */
export async function runContentFloor(input: ContentFloorInput): Promise<ContentFloorResult> {
  const cap = Math.max(resourceCapForOrigin(input.origin), input.existingChars ?? 0);
  const checks = [
    checkDefaultIdentitySafe(input.directory, input.slug),
    ...(await runContentChecks(input.body, cap)),
  ];
  const decision = composeTrustDecision(checks, { reviewRouted: false });
  return { allowed: WRITE_ALLOWED_DECISIONS.has(decision), decision, checks };
}

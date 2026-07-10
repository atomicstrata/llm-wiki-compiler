/**
 * @file src/artifacts/enforce-precondition.ts
 * @description The write-time ARTIFACT-existence precondition enforcer — the seam a
 * live-apply typed-page write composes so a page can enter a lifecycle state
 * declaring `transitionArtifactRequirements` only when the pinned artifactRef
 * RESOLVES HEALTHY. Mirrors `../relations/enforce-precondition.ts` (do not fork its
 * discipline): a DELIBERATE two-error split lets a workflow tell a genuine denial
 * from a transient one:
 *   - {@link ArtifactPreconditionUnmetError} — a required ref is absent/unparseable,
 *     or resolves to a CONFIRMED violation (dangling / hash-mismatch / schema-invalid
 *     / bytes-tampered / a manifest INTEGRITY-LIE). A HARD denial; the write must not land.
 *   - {@link ArtifactPreconditionUnverifiableError} — the artifact could not be READ
 *     (unreadable) or the manifest is a GENUINE store fault (malformed). "Cannot
 *     verify", NOT "violated": still fail-closed, but a DISTINCT type so a caller PARKS/
 *     retries a healthy run rather than terminally failing it.
 *
 * The deny/park split does NOT follow the health string 1:1 — `resolveArtifactRef`
 * overloads `artifact-store-unavailable` across an integrity-lie (deny) and a genuine
 * fault (park); we read its `storeFault` discriminant to split them. LOCK-FREE: reads
 * only through the confined `resolveArtifactRef`, acquires nothing (runs inside the
 * caller's held project lock).
 */
import { parseArtifactRef } from "./ref.js";
import { resolveArtifactRef, type ArtifactHealth, type StoreFaultReason } from "./resolve.js";
import type { LifecycleDef, ProfilePack } from "../profile/types.js";

/** Thrown when a required artifact is absent or resolves to a CONFIRMED violation — a HARD denial. */
export class ArtifactPreconditionUnmetError extends Error {
  /** One message per unmet requirement (field + why). */
  readonly unmet: string[];
  constructor(unmet: string[]) {
    super(`artifact preconditions unmet: ${unmet.join("; ")}`);
    this.name = "ArtifactPreconditionUnmetError";
    this.unmet = unmet;
  }
}

/** Thrown when a required artifact could not be VERIFIED (unreadable / genuine store fault) — PARK, do not fail terminally. */
export class ArtifactPreconditionUnverifiableError extends Error {
  constructor(detail: string) {
    super(`cannot verify artifact preconditions: ${detail}`);
    this.name = "ArtifactPreconditionUnverifiableError";
  }
}

/** The three-way verdict for one resolved ref. */
type ArtifactVerdict = "pass" | "deny" | "park";

/**
 * Map a resolve verdict to pass/deny/park per the OQ10 table. `ok` passes;
 * `artifact-unreadable` and a GENUINE-FAULT `store-unavailable` park; every other
 * non-ok health — including an INTEGRITY-LIE `store-unavailable` — denies. Exported
 * for the unit test that pins the table.
 */
export function classifyArtifactHealth(health: ArtifactHealth, storeFault: StoreFaultReason | undefined): ArtifactVerdict {
  if (health === "ok") return "pass";
  if (health === "artifact-unreadable") return "park";
  if (health === "artifact-store-unavailable") return storeFault === "genuine-fault" ? "park" : "deny";
  return "deny"; // dangling / hash-mismatch / schema-invalid / bytes-tampered
}

/** Inputs to {@link enforceArtifactPreconditions}; grouped to keep the arg list small. */
export interface EnforceArtifactPreconditionsArgs {
  /** Absolute project root (the CALLER already holds its lock). */
  root: string;
  /** The active profile, ALREADY loaded under the held lock. */
  profile: ProfilePack;
  /** The transitioning entity's type. */
  entityType: string;
  /** The transitioning entity's slug. */
  slug: string;
  /** The lifecycle state being ENTERED, whose artifact preconditions are enforced. */
  enteredState: string;
  /** The governing lifecycle def carrying `transitionArtifactRequirements`. */
  lifecycle: LifecycleDef;
  /** The entering page's parsed frontmatter (carries the artifactRef field value). */
  meta: Record<string, unknown>;
}

/**
 * Enforce the artifact-existence preconditions for an entity ENTERING `enteredState`.
 * Returns normally when every required ref resolves healthy (or the state declares
 * none). EARLY-OUT reads NOTHING when the state has no requirement. Otherwise throws
 * {@link ArtifactPreconditionUnmetError} (a CONFIRMED violation exists) or
 * {@link ArtifactPreconditionUnverifiableError} (only unverifiable outcomes, no
 * confirmed violation) — deny beats park so a run with any real violation fails hard.
 *
 * @param args - Root, under-lock profile, entity type/slug, entered state, lifecycle, meta.
 * @throws {ArtifactPreconditionUnmetError} On a missing ref or a confirmed violation.
 * @throws {ArtifactPreconditionUnverifiableError} When only unverifiable outcomes occurred.
 */
export async function enforceArtifactPreconditions(args: EnforceArtifactPreconditionsArgs): Promise<void> {
  const reqs = args.lifecycle.transitionArtifactRequirements?.[args.enteredState];
  if (reqs === undefined || reqs.length === 0) return; // early-out: read NOTHING
  const denials: string[] = [];
  const parks: string[] = [];
  for (const req of reqs) {
    const ref = parseArtifactRef(args.meta[req.field]);
    if (!ref) { denials.push(`field ${JSON.stringify(req.field)} carries no resolvable ${req.artifactType} artifact ref`); continue; }
    // BIND the pinned ref's declared TYPE to the required type BEFORE resolving. The
    // field's `artifactTypes` scope may admit several types (M1 accepts that), but THIS
    // precondition requires one specific type — a healthy artifact of a DIFFERENT
    // in-scope type must NOT satisfy it, else a type-confused ref bypasses the gate.
    if (ref.artifactType !== req.artifactType) {
      denials.push(`field ${JSON.stringify(req.field)} pins a ${ref.artifactType} artifact but a ${req.artifactType} is required`);
      continue;
    }
    const { health, storeFault } = await resolveArtifactRef(args.root, args.profile, ref);
    const verdict = classifyArtifactHealth(health, storeFault);
    if (verdict === "deny") denials.push(`field ${JSON.stringify(req.field)} artifact ${ref.slug} is ${health}`);
    else if (verdict === "park") parks.push(`field ${JSON.stringify(req.field)} artifact ${ref.slug} is ${health}`);
  }
  if (denials.length > 0) throw new ArtifactPreconditionUnmetError(denials);
  if (parks.length > 0) throw new ArtifactPreconditionUnverifiableError(parks.join("; "));
}

/**
 * @file src/products/readiness.ts
 * @description The readiness review behind `llmwiki product status` (AutoSci
 * AS-1 §4.1 `setup`): for each OPTIONAL capability the installed pack declares,
 * is it available, what does it affect, and what degrades without it.
 *
 * IT WRITES NOTHING AND RESOLVES NO SECRET. §4.1's contract is that the review
 * "does not touch the wiki", and re-running must be safe, so this reads the
 * operator's credential registry in its DESCRIPTOR-ONLY form: a handle names a
 * slot, and whether a handle exists for a slot is the entire readiness test. No
 * credential bytes are read, so a review can be run at any time by anyone who
 * can read the project, and running it twice is the same as running it once.
 *
 * "COULD NOT TELL" IS NOT "NOT CONFIGURED", and keeping them apart is the whole
 * reason this module has three states instead of a boolean. An unreadable or
 * malformed registry means the review has no idea whether the capability is
 * available; reporting that as `not-configured` would tell an operator to go
 * configure something that may already be configured, and would quietly turn a
 * broken registry into a routine-looking nudge. §4.1 pins that unavailable
 * capabilities are reported HONESTLY, and honesty here means admitting ignorance
 * as its own answer.
 *
 * THE HOST NEVER LEARNS WHAT THE PRODUCT IS. Every describing string is a
 * pack-declared key and every capability is a pack-declared slot, so this
 * reports AutoSci, a newsroom, or anything else without naming any of them.
 */

import { readCredentialRegistryState } from "../capability-providers/authority/credentials.js";
import type { AuthorizedProviderPaths } from "../capability-providers/packages/paths.js";
import type { CredentialSourceDescriptorV1 } from "../capability-providers/authority/types.js";
import type { ProductReadinessDimensionV2, ProviderRequirementV2 } from "../operations-packs/types.js";
import { installedProviderPinDigests } from "../capability-providers/packages/resolve.js";
import { readProviderGrantState } from "../capability-providers/authority/grants-store.js";
import { projectGrantScopeDigest } from "../capability-providers/authority/grants-resolve.js";

/**
 * What the review could establish about one declared capability.
 *
 * THREE STATES FOR A BOUND CREDENTIAL, because "a handle names the slot" and
 * "this will actually work" are different claims:
 *
 * - `available` — a handle is bound AND its source resolves: an environment
 *   variable that is actually set. The strongest claim this review can make
 *   without invoking anything.
 * - `source-missing` — a handle is bound and its source does NOT resolve. The
 *   most useful state in the set: configuration LOOKS complete and an
 *   invocation would fail anyway, which is exactly the situation an operator
 *   cannot diagnose from a binary ready/not-ready answer.
 * - `credential-bound` — bound, but the source is one this review cannot test
 *   without reading secrets (an OS keychain). Honest ignorance, not a promise.
 *
 * `provider-missing` covers the other half of "would this work": a capability
 * whose provider requirement names allowed package pins, none of which is
 * installed. Credentials can be perfect and the call still cannot be made,
 * which is again invisible to a binary ready/not-ready answer.
 *
 * `grant-missing` is the last prerequisite: the provider requirement asks for
 * grant kinds this PROJECT has not granted, so the call would be refused with
 * credentials and provider both in place. Grants are project-scoped, so a
 * capability can be usable in one checkout and not another.
 *
 * THE THREE GAPS ARE REPORTED IN DEPENDENCY ORDER — credential, then provider,
 * then grant — because each is a prerequisite of the next. Reporting a later
 * gap while an earlier one is open would send an operator to fix the second
 * problem first and then hit the first one anyway.
 *
 * `unknown` is a first-class answer, not an error, and `undeclared` covers a
 * dimension from the legacy bare-slug form, which names a capability without
 * naming any way to test it: see the file docblock.
 *
 * `skipped` OUTRANKS EVERY OTHER STATE because it records a DECISION rather
 * than an observation. Once a person has declined a capability, "not
 * configured" stops being news — the review should say someone chose this, not
 * repeat a nudge they already answered.
 */
export type ReadinessStateV1 =
  | "available" | "source-missing" | "provider-missing" | "grant-missing" | "credential-bound"
  | "not-configured" | "unknown" | "undeclared" | "skipped";

/** One reviewed capability: what it is, whether it is available, and the cost. */
export interface ReadinessReportItemV1 {
  readonly dimensionId: string;
  readonly state: ReadinessStateV1;
  /** The slot to bind a credential to, when the pack declared one. */
  readonly credentialSlotId?: string;
  readonly summaryKey?: string;
  readonly degradedSummaryKey?: string;
}

/** One complete readiness review over everything the pack declares. */
export interface ReadinessReportV1 {
  readonly items: readonly ReadinessReportItemV1[];
  /**
   * True when the pack declares no optional capabilities at all — a product
   * that works with no credentials anywhere. Distinct from an empty review
   * caused by an unreadable registry, which yields `unknown` items instead.
   */
  readonly declaresNoOptionalCapabilities: boolean;
}

/** One bound slot and whether its credential source resolves. */
type SlotAvailabilityV1 = "available" | "source-missing" | "untestable";

/**
 * Does this handle's source actually resolve?
 *
 * ONLY EXISTENCE IS CHECKED, NEVER THE VALUE. The whole review is
 * descriptor-only, so it asks whether the environment variable is set — not
 * what it contains. A keychain source cannot be answered without reading the
 * secret, so it is reported untestable rather than guessed at.
 */
function sourceAvailability(source: CredentialSourceDescriptorV1): SlotAvailabilityV1 {
  if (source.kind !== "environment") return "untestable";
  const value = process.env[source.variable];
  return value !== undefined && value.length > 0 ? "available" : "source-missing";
}

/** Bound slots mapped to their source availability, or null if unknowable. */
async function boundSlots(
  paths: AuthorizedProviderPaths,
): Promise<ReadonlyMap<string, SlotAvailabilityV1> | null> {
  const read = await readCredentialRegistryState(paths);
  // `absent` is a DEFINITE answer: no registry means no handle is bound to any
  // slot, so every capability is genuinely not configured. Only `unreadable`
  // and `invalid` leave the review unable to say.
  if (read.kind === "absent") return new Map();
  if (read.kind !== "ok") return null;
  return new Map(Object.values(read.registry.handles)
    .map((handle) => [handle.slotId, sourceAvailability(handle.source)] as const));
}

/**
 * Review every optional capability a pack declares against operator credentials.
 *
 * @param paths - The authorized provider paths the credential registry lives under.
 * @param dimensions - The pack's declared optional capabilities.
 * @returns One item per declared capability, in declaration order.
 */
export async function reviewProductReadiness(
  paths: AuthorizedProviderPaths, dimensions: readonly ProductReadinessDimensionV2[],
  skipped: ReadonlySet<string> | null = new Set(),
  requirements: readonly ProviderRequirementV2[] = [],
  projectRoot?: string,
): Promise<ReadinessReportV1> {
  // NO DIMENSIONS, NO READ. A product that declares no optional capabilities
  // has no question for the credential registry to answer, and reading operator
  // credential state to answer nothing is a side effect a read-only review has
  // no business having.
  if (dimensions.length === 0) return { items: [], declaresNoOptionalCapabilities: true };
  const bound = await boundSlots(paths);
  const installed = await installedPins(paths, requirements);
  const providers = providerBackedDimensions(installed, requirements);
  const granted = await grantedDimensions(paths, requirements, projectRoot, installed);
  // STATIC pack data, never store state: which dimensions some requirement
  // names is read off the requirements themselves, so an unreadable install
  // store cannot demote a checkable dimension to `undeclared`.
  const named = new Set(requirements.flatMap((requirement) => requirement.requiredReadinessDimensions));
  const items = dimensions.map((dimension) => ({
    ...dimension,
    state: stateFor(dimension, bound, skipped, providers, granted, named),
  }));
  return { items, declaresNoOptionalCapabilities: dimensions.length === 0 };
}

/**
 * One capability's reported state, with a recorded decision taking precedence.
 *
 * An UNREADABLE skip record yields `unknown` for every dimension: the review
 * cannot tell whether this capability was declined, and re-reporting it as
 * merely unconfigured would erase a decision it simply failed to read.
 */
function stateFor(
  dimension: ProductReadinessDimensionV2,
  bound: ReadonlyMap<string, SlotAvailabilityV1> | null,
  skipped: ReadonlySet<string> | null,
  providers: ReadonlyMap<string, boolean> | null,
  granted: ReadonlyMap<string, boolean> | null,
  named: ReadonlySet<string>,
): ReadinessStateV1 {
  if (skipped === null) return "unknown";
  if (skipped.has(dimension.dimensionId)) return "skipped";
  const gate = credentialGate(dimension, bound, named);
  if (gate !== null) return gate;
  if (providers === null) return "unknown";
  if (providers.get(dimension.dimensionId) === false) return "provider-missing";
  if (granted === null) return "unknown";
  return granted.get(dimension.dimensionId) === false ? "grant-missing" : "available";
}

/**
 * The credential leg's verdict: a state to report now, or null to proceed to
 * the provider and grant checks.
 *
 * A CREDENTIAL-LESS DIMENSION IS CHECKABLE WHEN A REQUIREMENT NAMES IT. The
 * `undeclared` state exists for legacy bare slugs that declare no way to be
 * checked at all — but a dimension with no credential slot that a provider
 * requirement DOES name (a local extraction provider, say) can still be
 * checked for install and grant, and reporting it `undeclared` made the review
 * blind to exactly the capability it existed to report. Only a dimension
 * nothing names remains `undeclared`.
 *
 * A MISSING PROVIDER OUTRANKS A GOOD CREDENTIAL, because it is the binding
 * constraint — but it does NOT outrank a missing credential: reporting the
 * provider gap while the credential is also absent would send an operator to
 * fix the second problem first. That is why every non-available credential
 * state short-circuits here.
 */
function credentialGate(
  dimension: ProductReadinessDimensionV2,
  bound: ReadonlyMap<string, SlotAvailabilityV1> | null,
  named: ReadonlySet<string>,
): ReadinessStateV1 | null {
  const credential = readinessOf(bound, dimension.credentialSlotId);
  if (credential === "available") return null;
  if (credential === "undeclared") return named.has(dimension.dimensionId) ? null : "undeclared";
  return credential;
}

/**
 * Which dimensions have every grant kind their requirement asks for.
 *
 * GRANTS ARE PROJECT-SCOPED, so this matches records against THIS project's
 * scope digest: a capability granted in one checkout is not granted in another,
 * and reporting otherwise would promise a call that gets refused.
 */
async function grantedDimensions(
  paths: AuthorizedProviderPaths, requirements: readonly ProviderRequirementV2[],
  projectRoot: string | undefined, installed: ReadonlySet<string> | null,
): Promise<ReadonlyMap<string, boolean> | null> {
  // EVERY provider requirement that names a readiness dimension launches a
  // provider for that dimension, and a launch needs a project grant RECORD
  // bound to an allowed installed pin — even a requirement requesting NO grant
  // kind (a proposal-only provider like discover) cannot construct its
  // authority without one. Checking only requirements that request kinds
  // reported such a provider `available` with no grant, then the invocation
  // could not launch. But a requirement naming NO dimension poses no readiness
  // question (mirroring `installedPins`), so the grant store is not read for
  // it — reading it would let an unrelated requirement's unreadable store turn
  // a credential-only dimension `unknown`.
  const posesGrantQuestion = requirements.some(
    (requirement) => requirement.requiredReadinessDimensions.length > 0);
  if (!posesGrantQuestion || projectRoot === undefined) return new Map();
  if (installed === null) return null;
  const grants = await projectGrantRecords(paths, projectRoot);
  if (grants === null) return null;
  // A REQUIREMENT IS ONE JOINED UNIT. Folding install and grant checks
  // independently combined requirement A's installed provider with requirement
  // B's grant on the same dimension — `available`, though NEITHER provider
  // could serve the call. Each requirement must be satisfied whole — an
  // installed allowed pin, and a grant that spends on such a pin — and only
  // then do requirements fold by dimension.
  return foldRequirements(requirements, (requirement) =>
    pinInstalled(requirement, installed) && grantSatisfies(requirement, grants, installed));
}

/**
 * True when the requirement's grant leg is met: no kinds requested, or ONE
 * grant whose pin the requirement allows AND is installed carries every
 * requested kind. The runtime spends a grant on its exact pin, so a grant
 * bound to an absent provider cannot make a requirement ready.
 */
function grantSatisfies(
  requirement: ProviderRequirementV2, grants: readonly ProjectGrantRecordV1[],
  installed: ReadonlySet<string>,
): boolean {
  // No short-circuit for empty kinds: a launch needs a grant RECORD regardless.
  // The per-kind `.every` below is vacuously true when no kind is requested, so
  // this reduces to "a grant exists on an allowed, installed pin".
  return grants.some((record) =>
    pinAllowed(requirement, record.providerPinDigest)
    && installed.has(record.providerPinDigest)
    && requirement.requestedGrantKinds.every((kind) =>
      record.kinds.has(dottedGrantKind(kind))));
}

/** True when the requirement's allowed pins admit this grant's provider. */
function pinAllowed(requirement: ProviderRequirementV2, pinDigest: string): boolean {
  // No declared pins imposes no provider constraint — the same reading the
  // install check gives an empty allowlist.
  return requirement.allowedProviderPins.length === 0
    || (requirement.allowedProviderPins as readonly string[]).includes(pinDigest);
}

/** One project-scoped grant: the provider pin it binds and the kinds it carries. */
interface ProjectGrantRecordV1 {
  readonly providerPinDigest: string;
  readonly kinds: ReadonlySet<string>;
}

/** Every grant bound to THIS project, each keeping its own pin and kinds. */
async function projectGrantRecords(
  paths: AuthorizedProviderPaths, projectRoot: string,
): Promise<readonly ProjectGrantRecordV1[] | null> {
  const read = await readProviderGrantState(paths);
  if (read.kind === "absent") return [];
  if (read.kind !== "ok") return null;
  const scope = await projectGrantScopeDigest(projectRoot);
  return Object.values(read.state.grants)
    .filter((record) => record.projectRealpathDigest === scope)
    .map((record) => ({
      providerPinDigest: String(record.providerPinDigest),
      kinds: new Set(record.grant.authority.map((atom) => atom.kind)),
    }));
}

/**
 * The pack grammar spells grant kinds as SLUGS ("source-read") because its
 * identifier grammar refuses dots, while authority atoms use the platform's
 * dotted vocabulary ("source.read"). Every grant kind is two segments, so the
 * first dash maps uniquely. Without this translation the check was doubly
 * unreachable from a pack: an empty list skipped it, and a nonempty slug could
 * never equal a dotted atom kind.
 */
function dottedGrantKind(slug: string): string {
  return slug.replace("-", ".");
}

/**
 * Map each required dimension to whether ANY requirement needing it is
 * satisfied: a dimension required by two providers is available once either
 * one can serve it.
 */
function foldRequirements(
  requirements: readonly ProviderRequirementV2[],
  satisfies: (requirement: ProviderRequirementV2) => boolean,
): ReadonlyMap<string, boolean> {
  const backed = new Map<string, boolean>();
  for (const requirement of requirements) {
    const satisfied = satisfies(requirement);
    for (const dimension of requirement.requiredReadinessDimensions) {
      backed.set(dimension, (backed.get(dimension) ?? false) || satisfied);
    }
  }
  return backed;
}

/**
 * The installed provider pin set both legs judge against, or null when
 * unknowable. Nothing naming a dimension means no question to answer, so the
 * install store is not read at all.
 */
async function installedPins(
  paths: AuthorizedProviderPaths, requirements: readonly ProviderRequirementV2[],
): Promise<ReadonlySet<string> | null> {
  if (requirements.every((requirement) => requirement.requiredReadinessDimensions.length === 0)) {
    return new Set();
  }
  try {
    // PIN digests, not PACKAGE digests. A requirement names providers by pin —
    // a nine-field record binding the package, its manifest and ONE capability —
    // so comparing against package digests compares digests over different
    // values and reports every correctly installed provider as missing.
    return await installedProviderPinDigests(paths);
  } catch {
    return null;
  }
}

/**
 * Which dimensions have an allowed provider package actually installed.
 *
 * A dimension no provider requirement names is absent from the map, and is
 * therefore never reported `provider-missing`: nothing declared that it needs a
 * provider, so there is no gap to report.
 */
function providerBackedDimensions(
  installed: ReadonlySet<string> | null, requirements: readonly ProviderRequirementV2[],
): ReadonlyMap<string, boolean> | null {
  if (installed === null) return null;
  return foldRequirements(requirements, (requirement) => pinInstalled(requirement, installed));
}

/**
 * True when the requirement's install leg is met. A requirement declaring NO
 * allowed pins imposes no install constraint, so there is nothing to be
 * missing — treating an empty list as unsatisfied would manufacture a gap
 * nobody declared.
 */
function pinInstalled(requirement: ProviderRequirementV2, installed: ReadonlySet<string>): boolean {
  return requirement.allowedProviderPins.length === 0
    || requirement.allowedProviderPins.some((pin) => installed.has(pin));
}

/** One capability's state: undeclared, unknowable, bound, or genuinely absent. */
function readinessOf(
  bound: ReadonlyMap<string, SlotAvailabilityV1> | null, slotId: string | undefined,
): ReadinessStateV1 {
  if (slotId === undefined) return "undeclared";
  if (bound === null) return "unknown";
  const availability = bound.get(slotId);
  if (availability === undefined) return "not-configured";
  if (availability === "untestable") return "credential-bound";
  return availability;
}

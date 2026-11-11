/**
 * @file src/products/binding/resolve.ts
 * @description Classify a project's runtime mode from its active-product binding
 * (design section 8.2) and, in product mode, resolve the effective profile from
 * the installed package's knowledge-profile member. There are exactly two healthy
 * modes: LEGACY (no binding — the caller runs the existing `loadProfile` path
 * unchanged) and PRODUCT (a present, healthy binding whose exact installed package
 * resolves and whose component digests match its manifest). Every unhealthy state
 * is `unavailable` and NEVER falls back to legacy: a malformed/unsafe binding, an
 * unresolved or digest-mismatched package, or an unloadable knowledge profile. A
 * binding present beside a legacy `profile.json` is a `conflict` — neither wins.
 *
 * ACYCLIC RULE: this resolver loads the knowledge-profile member bytes and
 * validates them DIRECTLY through {@link ../../profile/validate} /
 * {@link ../../profile/digest} (via {@link loadKnowledgeProfileMember}). It NEVER
 * calls `loadProfile()`; `profile/load.ts` imports THIS module, not the reverse.
 *
 * UNIVERSAL effective authority: this resolution backs the single {@link ../../profile/load.loadProfile}
 * entry point every reader uses, so product mode is coherent across ALL surfaces —
 * workflows, search/retrieval, the linter, embeddings, context assembly, the
 * operations-authority resolver, the profile commands, and the rest all authorize
 * against the exact product package and its knowledge profile, never the default.
 */

import { MAX_KNOWLEDGE_PROFILE_BYTES } from "../constants.js";
import {
  diskProductPackageReads, readInstalledProductPackageFrom, type ProductPackageReads, type VerifiedMemberBytes,
} from "../packages/store.js";
import type { LoadedProfile } from "../../profile/types.js";
import type { ProductPackageManifestV1 } from "../types.js";
import {
  bindingComponentMismatch, knowledgeProfileMemberPath, loadKnowledgeProfileMember, readStoredMemberTextFrom,
  verifiedMemberText,
} from "./manifest-authority.js";
import {
  diskActiveBindingReads, profileJsonPresentFrom, readActiveProductBindingFrom, type ActiveBindingReads,
} from "./store.js";
import type { ActiveProductBindingV1 } from "./types.js";

/**
 * The classified runtime mode (design section 8.2). `legacy` means run the
 * existing profile loader unchanged; `product` carries the resolved binding and
 * effective profile, and the installed package's manifest exactly as this
 * resolution read and verified it, so a caller needing the manifest does not
 * read and re-verify the same content-addressed package a second time, with the
 * member bytes that read verified (`verifiedMembers`) for the same reason; `conflict`
 * means a binding and a legacy `profile.json` coexist; `unavailable` carries a
 * fail-closed reason and never degrades to legacy.
 */
export type ActiveProductResolution =
  | { mode: "legacy" }
  | {
    mode: "product"; binding: ActiveProductBindingV1; loaded: LoadedProfile;
    manifest: ProductPackageManifestV1; verifiedMembers: VerifiedMemberBytes;
  }
  | { mode: "conflict" }
  | { mode: "unavailable"; detail: string };

/**
 * Everything {@link resolveActiveProductFrom} reads. OWNED BY THE RESOLVER: a
 * narrow seam with one disk implementation; not `ProjectStore`, not a hosted or
 * access-control contract, and it selects no backend. Nothing ties the three to
 * one project; production builds all from one root.
 */
export interface ActiveProductSources {
  /**
   * The project root as the caller gave it. NOT READ THROUGH: it only builds the
   * paths reported as `loadedFrom` (the knowledge-profile member here, the
   * legacy profile in `profile/load.ts`). The ONE origin for both.
   */
  root: string;
  /** The binding leaf and the looks at the private directory. */
  binding: ActiveBindingReads;
  /** The installed package and its members. */
  packages: ProductPackageReads;
}

/** LOCAL DISK. The sources for the project at `root`. Building them does no I/O. In no package index. */
export function diskActiveProductSources(root: string): ActiveProductSources {
  return { root, binding: diskActiveBindingReads(root), packages: diskProductPackageReads(root) };
}

/**
 * Load the product-mode effective profile from the knowledge-profile member:
 * the bytes the package read verified when it kept them, else the capped read.
 */
async function loadProductProfile(
  sources: ActiveProductSources, binding: ActiveProductBindingV1,
  manifest: ProductPackageManifestV1, verifiedMembers: VerifiedMemberBytes,
): Promise<LoadedProfile> {
  const text = verifiedMemberText(verifiedMembers, manifest.knowledgeProfile, MAX_KNOWLEDGE_PROFILE_BYTES)
    ?? await readStoredMemberTextFrom(sources.packages, binding.packageDigest, manifest.knowledgeProfile, MAX_KNOWLEDGE_PROFILE_BYTES);
  const memberPath = knowledgeProfileMemberPath(sources.root, binding.packageDigest, manifest.knowledgeProfile.digest);
  return loadKnowledgeProfileMember(text, memberPath);
}

/**
 * Resolve a present, non-conflicting binding to product mode or `unavailable`.
 * The package read is OUTSIDE the `try`: if it rejects, that same error leaves.
 * Only the knowledge-profile member load is inside it, where any throw becomes
 * `unavailable` carrying its message.
 */
async function resolveProductMode(
  sources: ActiveProductSources, binding: ActiveProductBindingV1,
): Promise<ActiveProductResolution> {
  const pkg = await readInstalledProductPackageFrom(sources.packages, binding.packageDigest);
  if (pkg.status !== "ok") return { mode: "unavailable", detail: `package-${pkg.status}` };
  const mismatch = bindingComponentMismatch(binding, pkg.manifest);
  if (mismatch !== null) return { mode: "unavailable", detail: `component-mismatch:${mismatch}` };
  try {
    const loaded = await loadProductProfile(sources, binding, pkg.manifest, pkg.verifiedMembers);
    return { mode: "product", binding, loaded, manifest: pkg.manifest, verifiedMembers: pkg.verifiedMembers };
  } catch (error) {
    return { mode: "unavailable", detail: error instanceof Error ? error.message : "knowledge-profile" };
  }
}

/**
 * Resolve the project's runtime mode from `.llmwiki/active-product.json`. An absent
 * binding is legacy mode (no discovery, network, install, or project writes); a
 * present binding beside a legacy `profile.json` is a conflict; a present healthy
 * binding resolves to product mode; every present-but-unhealthy binding is
 * unavailable and never falls back to legacy.
 */
export async function resolveActiveProduct(root: string): Promise<ActiveProductResolution> {
  // `async` so that a throw while the disk sources are built REJECTS, as this function always did.
  return resolveActiveProductFrom(diskActiveProductSources(root));
}

/**
 * {@link resolveActiveProduct} over {@link ActiveProductSources}: THE ONE BODY.
 * In order: the binding leaf (absent is legacy; malformed is unavailable); the
 * profile-presence look (present is a conflict, and no package read follows);
 * then the package. Nothing is remembered between calls.
 */
export async function resolveActiveProductFrom(sources: ActiveProductSources): Promise<ActiveProductResolution> {
  const read = await readActiveProductBindingFrom(sources.binding);
  if (read.kind === "absent") return { mode: "legacy" };
  if (read.kind === "malformed") return { mode: "unavailable", detail: read.detail };
  if (await profileJsonPresentFrom(sources.binding)) return { mode: "conflict" };
  return resolveProductMode(sources, read.binding);
}

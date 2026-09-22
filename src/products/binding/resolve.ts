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
import { readInstalledProductPackage } from "../packages/store.js";
import type { LoadedProfile } from "../../profile/types.js";
import type { ProductPackageManifestV1 } from "../types.js";
import {
  bindingComponentMismatch, knowledgeProfileMemberPath, loadKnowledgeProfileMember, readStoredMemberText,
} from "./manifest-authority.js";
import { profileJsonPresent, readActiveProductBinding } from "./store.js";
import type { ActiveProductBindingV1 } from "./types.js";

/**
 * The classified runtime mode (design section 8.2). `legacy` means run the
 * existing profile loader unchanged; `product` carries the resolved binding and
 * effective profile; `conflict` means a binding and a legacy `profile.json`
 * coexist; `unavailable` carries a fail-closed reason and never degrades to legacy.
 */
export type ActiveProductResolution =
  | { mode: "legacy" }
  | { mode: "product"; binding: ActiveProductBindingV1; loaded: LoadedProfile }
  | { mode: "conflict" }
  | { mode: "unavailable"; detail: string };

/** Load the product-mode effective profile from the knowledge-profile member. */
async function loadProductProfile(
  root: string, binding: ActiveProductBindingV1, manifest: ProductPackageManifestV1,
): Promise<LoadedProfile> {
  const text = await readStoredMemberText(
    root, binding.packageDigest, manifest.knowledgeProfile, MAX_KNOWLEDGE_PROFILE_BYTES);
  const memberPath = knowledgeProfileMemberPath(root, binding.packageDigest, manifest.knowledgeProfile.digest);
  return loadKnowledgeProfileMember(text, memberPath);
}

/** Resolve a present, non-conflicting binding to product mode or `unavailable`. */
async function resolveProductMode(
  root: string, binding: ActiveProductBindingV1,
): Promise<ActiveProductResolution> {
  const pkg = await readInstalledProductPackage(root, binding.packageDigest);
  if (pkg.status !== "ok") return { mode: "unavailable", detail: `package-${pkg.status}` };
  const mismatch = bindingComponentMismatch(binding, pkg.manifest);
  if (mismatch !== null) return { mode: "unavailable", detail: `component-mismatch:${mismatch}` };
  try {
    const loaded = await loadProductProfile(root, binding, pkg.manifest);
    return { mode: "product", binding, loaded };
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
  const read = await readActiveProductBinding(root);
  if (read.kind === "absent") return { mode: "legacy" };
  if (read.kind === "malformed") return { mode: "unavailable", detail: read.detail };
  if (await profileJsonPresent(root)) return { mode: "conflict" };
  return resolveProductMode(root, read.binding);
}

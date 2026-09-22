/**
 * @file src/capability-providers/host/install.ts
 * @description Installing a provider you WROTE, during development, and
 * learning the pin a pack must declare to name it.
 *
 * IT ADDS NO INSTALLATION PATH OF ITS OWN. It calls the platform's ordinary
 * local-development install and its separate explicit execution approval, in
 * that order, with no test-only minting and no relaxation of package parsing,
 * digest confirmation, or tree verification. What it adds is the ONE thing a
 * developer otherwise cannot get: the pin digest their pack has to name, which
 * until now only a test fixture knew how to compute.
 *
 * THE PIN IS DERIVED FROM THE PACKAGE, NEVER SUPPLIED. Every field comes out of
 * the payload the installer just verified, so a pin cannot describe a provider
 * other than the one on disk. A hand-written pin digest in a pack is the defect
 * this exists to prevent: it would name a provider nobody could prove was
 * installed, and the mismatch would surface as an unexplained refusal at run
 * time rather than at authoring time.
 *
 * APPROVAL IS SEPARATE AND EXPLICIT, as the platform models it: installing
 * bytes and consenting to execute them are two decisions, and this helper makes
 * the second one visible in its own signature rather than implying it.
 */

import {
  approveLocalProviderExecution, installLocalProvider,
} from "../packages/local-install.js";
import type { AuthorizedProviderPaths } from "../packages/paths.js";
import {
  derivePinForPayload, providerPinDigest,
} from "../packages/pin.js";
import {
  selectHostPlatformArtifact, type PlatformArtifactV1,
} from "../packages/protocol.js";
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import type { ProviderPinV1 } from "../types.js";

/** The package digest a local install confirms: the canonical digest of the payload. */
function packageDigestOf(payload: Record<string, unknown>): string {
  return canonicalDigest(payload);
}

/** What a developer supplies: their provider's tree and its package payload. */
export interface InstallDevProviderRequestV1 {
  /** The directory holding the provider's files, as the payload describes them. */
  readonly sourceRoot: string;
  /** The provider package payload; parsed and digest-confirmed by the platform. */
  readonly payload: Record<string, unknown>;
  /**
   * Explicit consent to EXECUTE these bytes later. Installing alone never
   * grants it, so this defaults to withholding approval.
   */
  readonly approveExecution?: boolean;
}

/** An installed development provider and the identity a pack names it by. */
export interface InstalledDevProviderV1 {
  readonly pin: ProviderPinV1;
  /** The value a pack's `defaultProviderPin` must carry to select this provider. */
  readonly providerPinDigest: string;
  readonly packageDigest: string;
  readonly approvedForExecution: boolean;
  /** The verified installed tree an invocation copies its launch root from. */
  readonly treePath: string;
  readonly artifact: PlatformArtifactV1;
  readonly manifestDigest: string;
  readonly artifactDigest: string;
  /** The capability descriptor, for the artifact outputs an invocation declares. */
  readonly capability: Record<string, unknown>;
}

/**
 * Install a local development provider and report the pin a pack names it by.
 *
 * @param paths - The host's authorized provider roots.
 * @param request - The provider's tree, its payload, and whether execution is
 *   approved.
 * @returns The derived pin, its digest, the package digest, and whether the
 *   provider may actually be executed.
 */
export async function installDevProvider(
  paths: AuthorizedProviderPaths, request: InstallDevProviderRequestV1,
): Promise<InstalledDevProviderV1> {
  const packageDigest = packageDigestOf(request.payload);
  const snapshot = await installLocalProvider(paths, {
    sourceRoot: request.sourceRoot, payload: request.payload,
    confirmedPackageDigest: packageDigest,
  });
  const approvedForExecution = request.approveExecution === true;
  if (approvedForExecution) {
    await approveLocalProviderExecution(paths, { packageDigest, confirmed: true });
  }
  // The coordinate comes off the INSTALL RECORD rather than being re-derived
  // from the payload, so the pin names the package as the platform filed it.
  const pin = derivePinForPayload(request.payload, String(snapshot.coordinate), packageDigest);
  const manifest = request.payload.manifest as Record<string, unknown>;
  const capability = (manifest.capabilities as Array<Record<string, unknown>>)[0]!;
  return {
    pin, providerPinDigest: providerPinDigest(pin), packageDigest, approvedForExecution,
    // Read off the INSTALL RECORD rather than the payload, so every launch input
    // describes the tree the installer actually verified and filed.
    treePath: snapshot.treePath, artifact: selectHostPlatformArtifact(request.payload as never),
    manifestDigest: String(snapshot.manifestDigest), artifactDigest: String(snapshot.artifactDigest),
    capability,
  };
}

/**
 * Re-exported so a caller of this package reaches the SAME derivation the
 * platform uses; a second copy here is what let a pin digest and a package
 * digest be confused in the first place.
 */
export { derivePinForPayload } from "../packages/pin.js";

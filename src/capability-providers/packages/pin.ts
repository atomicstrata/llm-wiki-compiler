/**
 * @file src/capability-providers/packages/pin.ts
 * @description Deriving the exact provider pins a package offers.
 *
 * A PIN AND A PACKAGE ARE DIFFERENT IDENTITIES, and confusing them is the
 * defect this module exists to prevent. A pack names a provider by the digest of
 * a PIN — a nine-field record binding the package, its manifest, and ONE of its
 * capabilities — while installed state records the package. Comparing a pin
 * digest against a package digest is comparing digests over different values, so
 * it never matches and reports every correctly installed provider as absent.
 *
 * THE PINS COME FROM THE PACKAGE, NEVER FROM A CALLER. Every field is read off
 * the payload and the install record, so a derived pin cannot describe a
 * provider other than the one on disk. One package offers one pin per declared
 * capability, because a pin names exactly one.
 */

import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import {
  parseCapabilityContractVersion, parseCapabilityId, parseProviderCoordinate, parseProviderId,
  parseSemanticVersion, parseSha256Digest,
} from "../ids.js";
import type { ProviderPinV1 } from "../types.js";

/** The capability fields a pin binds, as the manifest declares them. */
interface CapabilityShapeV1 {
  readonly capabilityId: unknown;
  readonly contractVersion: unknown;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly progressSchema?: unknown;
  readonly brokerRequirements?: unknown;
  readonly artifactOutputs?: unknown;
}

/** The digest a pin binds one capability's contract by. */
function capabilitySchemaDigest(capability: CapabilityShapeV1): string {
  return canonicalDigest({
    inputSchema: capability.inputSchema, outputSchema: capability.outputSchema,
    progressSchema: capability.progressSchema ?? null,
    brokerRequirements: capability.brokerRequirements, artifactOutputs: capability.artifactOutputs,
  });
}

/** The identity fields a pin takes from the package rather than the capability. */
interface PinPackageIdentityV1 {
  readonly coordinate: string;
  readonly providerId: unknown;
  readonly providerVersion: unknown;
  readonly packageDigest: unknown;
  readonly manifestDigest: unknown;
}

/** Derive the pin naming ONE capability of one package. */
function providerPinFor(
  identity: PinPackageIdentityV1, capability: CapabilityShapeV1,
): ProviderPinV1 {
  return {
    schemaVersion: 1,
    coordinate: parseProviderCoordinate(identity.coordinate).coordinate,
    providerId: parseProviderId(identity.providerId),
    providerVersion: parseSemanticVersion(identity.providerVersion),
    packageDigest: parseSha256Digest(identity.packageDigest),
    manifestDigest: parseSha256Digest(identity.manifestDigest),
    capabilityId: parseCapabilityId(capability.capabilityId),
    capabilityContractVersion: parseCapabilityContractVersion(capability.contractVersion),
    capabilitySchemaDigest: parseSha256Digest(capabilitySchemaDigest(capability)),
  };
}

/** Every pin one package payload offers: one per declared capability. */
export function providerPinsForPayload(
  payload: Record<string, unknown>, coordinate: string, packageDigest: string,
): readonly ProviderPinV1[] {
  const manifest = payload.manifest as Record<string, unknown>;
  const capabilities = (manifest.capabilities ?? []) as CapabilityShapeV1[];
  const identity: PinPackageIdentityV1 = {
    coordinate, providerId: payload.providerId, providerVersion: payload.providerVersion,
    packageDigest, manifestDigest: canonicalDigest(manifest),
  };
  return capabilities.map((capability) => providerPinFor(identity, capability));
}

/**
 * Derive the pin naming a package's FIRST capability.
 *
 * Kept because a single-capability package — the common development case — has
 * exactly one pin, and a caller that already knows this should not have to
 * index into a list to say so.
 */
export function derivePinForPayload(
  payload: Record<string, unknown>, coordinate: string, packageDigest: string,
): ProviderPinV1 {
  const pins = providerPinsForPayload(payload, coordinate, packageDigest);
  const first = pins[0];
  if (first === undefined) throw new Error("provider package declares no capability to pin");
  return first;
}

/** The digest a pack's `allowedProviderPins` entry must carry to name a pin. */
export function providerPinDigest(pin: ProviderPinV1): string {
  return canonicalDigest(pin);
}

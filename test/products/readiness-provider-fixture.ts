/** Real provider installation and pinned requirement construction for readiness witnesses. */
import { installDevProvider } from "../../src/capability-providers/host/install.js";
import { reviewProductReadiness } from "../../src/products/readiness.js";
import type { ProviderRequirementV2, ProductReadinessDimensionV2 } from "../../src/operations-packs/types.js";
import { devInstallMaterial, type ResolutionFixture } from "../capability-providers/resolution-fixture.js";

/** Build a required discovery provider with a caller-selected readiness dimension and fallback. */
export function readinessRequirement(pinDigest: string, dimension: string, fallback: "none" | "refuse"): ProviderRequirementV2 {
  return {
    roleId: "extractor", disposition: "required", capabilityId: "discover",
    capabilityContractDigest: `sha256:${"a".repeat(64)}`,
    allowedProviderPins: [pinDigest], defaultProviderPin: pinDigest,
    requiredReadinessDimensions: [dimension], requestedGrantKinds: [], fallbackPolicy: { kind: fallback },
  } as unknown as ProviderRequirementV2;
}

/** Install built fixture material through the real host admission path. */
export async function installReadinessProvider(fixture: ResolutionFixture, name: string, version: string) {
  const { sourceRoot, payload } = await devInstallMaterial(fixture, name, version);
  return installDevProvider(fixture.paths, { sourceRoot, payload, approveExecution: true });
}

/** Review one requirement and return its declared dimension rather than another report row. */
export async function reviewReadinessDimension(
  paths: ResolutionFixture["paths"], dimension: ProductReadinessDimensionV2, requirement: ProviderRequirementV2,
) {
  const report = await reviewProductReadiness(paths, [dimension], new Set(), [requirement]);
  return report.items.find((item) => item.dimensionId === dimension.dimensionId);
}

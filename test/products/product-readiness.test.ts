/**
 * @file test/products/product-readiness.test.ts
 * @description The readiness review behind `llmwiki product status` (AS-1 §4.1).
 *
 * THE CASE THIS SUITE EXISTS FOR IS `unknown`. A boolean "is it configured?"
 * would collapse two different situations — the operator has not bound a
 * credential, and the review could not read the registry to find out — into one
 * answer, and the wrong one: an unreadable registry would be reported as "not
 * configured", sending an operator to set up something they may already have
 * set up, and turning a broken registry into a routine-looking chore. §4.1 pins
 * that unavailable capabilities are reported HONESTLY, which means the review
 * has to be able to say it does not know.
 *
 * `absent` is deliberately NOT `unknown`: no registry at all is a definite
 * answer, because nothing can be bound to a slot when nothing is bound to
 * anything. The distinction is between "no" and "cannot tell", not between
 * "file present" and "file missing".
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authorizeProviderPathsForTest } from "../../src/capability-providers/packages/paths.js";
import { reviewProductReadiness } from "../../src/products/readiness.js";
import type { ProductReadinessDimensionV2, ProviderRequirementV2 } from "../../src/operations-packs/types.js";
import { tempRootTracker } from "../temp-roots.js";
import { parseWorkspaceContract } from "../../src/operations-packs/parse-contracts.js";

/** A minimal valid workspace contract, varied per case. */
const BASE_CONTRACT = {
  workspaceIdentityGrammar: "workspace.default",
  requiredKnowledgeProfileId: "autosci",
  compatibleKnowledgeProfileDigests: [], catalogSchemaDependencies: [],
  sourceSchemaDependencies: [], allowedContextRootPolicyIds: ["root-workspace"],
  declaredProjectionClasses: ["wiki"], requiredSettingFields: [],
  requiredProviderCapabilityRoles: [], supportedImportCompatibilityModes: ["link"],
  productReadinessDimensions: [],
};

const CREDENTIALS_FILE = "provider-credentials-v1.json";

/** One optional capability, gated on the `model-key` slot. */
const MODEL_DIMENSION: ProductReadinessDimensionV2 = {
  dimensionId: "model-ready", credentialSlotId: "model-key",
  summaryKey: "fixture.model.affects", degradedSummaryKey: "fixture.model.degraded",
};

const tracker = tempRootTracker();
afterEach(() => tracker.cleanup());

/** Isolated config/cache roots, authorized through the provider seam. */
async function isolatedPaths() {
  // `real` because macOS hands back a symlinked /var path, and the provider
  // seam refuses to authorize a root it cannot verify is not a symlink.
  const base = await tracker.create("readiness-", { real: true });
  const configRoot = path.join(base, "config");
  const cacheRoot = path.join(base, "cache");
  await mkdir(configRoot, { mode: 0o700 });
  await mkdir(cacheRoot, { mode: 0o700 });
  return { root: base, configRoot, paths: await authorizeProviderPathsForTest({ configRoot, cacheRoot }) };
}

/** Review one gated capability, optionally seeding the credentials file. */
async function reviewWith(credentialsText?: string) {
  const { configRoot, paths } = await isolatedPaths();
  if (credentialsText !== undefined) {
    await writeFile(path.join(configRoot, CREDENTIALS_FILE), credentialsText, "utf8");
  }
  return reviewProductReadiness(paths, [MODEL_DIMENSION]);
}

/** A registry binding one handle to `slotId`. */
function registryText(slotId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    handles: {
      "handle-1": {
        schemaVersion: 1, handleId: "handle-1", slotId,
        source: { kind: "environment", variable: "FIXTURE_KEY" },
        allowedBrokerIds: ["model"],
      },
    },
  });
}

describe("the product readiness review", () => {
  it("reports SOURCE MISSING when the bound credential's env var is not set", async () => {
    // The state that matters most: configuration LOOKS complete and the call
    // would fail anyway. A binary ready/not-ready answer hides exactly this.
    delete process.env.FIXTURE_KEY;
    const report = await reviewWith(registryText("model-key"));
    expect(report.items.map((item) => item.state)).toEqual(["source-missing"]);
  });

  it("reports AVAILABLE only once the source actually resolves", async () => {
    await withSourcePresent(async () => {
      const report = await reviewWith(registryText("model-key"));
      expect(report.items.map((item) => item.state)).toEqual(["available"]);
    });
  });

  it("reports CREDENTIAL BOUND for a source it cannot test without reading secrets", async () => {
    const keychain = JSON.stringify({
      schemaVersion: 1,
      handles: {
        "handle-1": {
          schemaVersion: 1, handleId: "handle-1", slotId: "model-key",
          source: { kind: "os-keychain", service: "llmwiki", account: "model" },
          allowedBrokerIds: ["model"],
        },
      },
    });
    const report = await reviewWith(keychain);
    expect(report.items.map((item) => item.state)).toEqual(["credential-bound"]);
  });

  it("reports UNDECLARED for a legacy bare-slug dimension, which cannot be checked", async () => {
    const { paths } = await isolatedPaths();
    const report = await reviewProductReadiness(paths, [{ dimensionId: "model-ready" }]);
    expect(report.items.map((item) => item.state)).toEqual(["undeclared"]);
  });

  it("reports NOT CONFIGURED when a registry exists but binds a different slot", async () => {
    const report = await reviewWith(registryText("some-other-slot"));
    expect(report.items.map((item) => item.state)).toEqual(["not-configured"]);
  });

  it("reports NOT CONFIGURED when no registry exists at all — a definite answer", async () => {
    const report = await reviewWith();
    expect(report.items.map((item) => item.state)).toEqual(["not-configured"]);
  });

  it("reports UNKNOWN, not not-configured, when the registry cannot be parsed", async () => {
    // The discriminating case: the review must refuse to guess. Answering
    // `not-configured` here would tell an operator to configure a capability
    // that may already be configured.
    const report = await reviewWith("{ this is not json");
    expect(report.items.map((item) => item.state)).toEqual(["unknown"]);
  });

  it("carries the pack's own description keys and slot through to the report", async () => {
    const report = await reviewWith(registryText("model-key"));
    expect(report.items[0]).toMatchObject({
      dimensionId: "model-ready", credentialSlotId: "model-key",
      summaryKey: "fixture.model.affects", degradedSummaryKey: "fixture.model.degraded",
    });
  });

  it("distinguishes a product declaring NO optional capabilities from an empty review", async () => {
    const { paths } = await isolatedPaths();
    const report = await reviewProductReadiness(paths, []);
    expect(report).toEqual({ items: [], declaresNoOptionalCapabilities: true });
  });
});

describe("an installed package keeps parsing across a host upgrade", () => {
  it("accepts the LEGACY bare-slug form that shipped before dimensions were objects", () => {
    // A store ecosystem where a core release bricks a published package is one
    // nobody can publish into, so the old form must never become a parse error.
    const contract = parseWorkspaceContract(
      { ...BASE_CONTRACT, productReadinessDimensions: ["model-ready"] }, "workspaceContract");
    expect(contract.productReadinessDimensions).toEqual([{ dimensionId: "model-ready" }]);
  });

  it("accepts the object form alongside it", () => {
    const contract = parseWorkspaceContract({
      ...BASE_CONTRACT,
      productReadinessDimensions: [{ dimensionId: "model-ready", credentialSlotId: "model-key" }],
    }, "workspaceContract");
    expect(contract.productReadinessDimensions)
      .toEqual([{ dimensionId: "model-ready", credentialSlotId: "model-key" }]);
  });
});


describe("a recorded skip in the review", () => {
  it("reports SKIPPED and still LISTS the capability", async () => {
    const { paths } = await isolatedPaths();
    const report = await reviewProductReadiness(paths, [MODEL_DIMENSION], new Set(["model-ready"]));
    // Listed, not omitted: the decision is the thing being recorded, and a
    // reader must be able to tell it from an oversight.
    expect(report.items).toHaveLength(1);
    expect(report.items[0]?.state).toBe("skipped");
  });

  it("outranks not-configured, so an answered nudge is not repeated", async () => {
    const { paths } = await isolatedPaths();
    const unskipped = await reviewProductReadiness(paths, [MODEL_DIMENSION], new Set());
    expect(unskipped.items[0]?.state).toBe("not-configured");
    const skipped = await reviewProductReadiness(paths, [MODEL_DIMENSION], new Set(["model-ready"]));
    expect(skipped.items[0]?.state).toBe("skipped");
  });

  it("reports UNKNOWN for every dimension when the skip record is unreadable", async () => {
    // The review cannot tell whether this was declined; calling it merely
    // unconfigured would erase a decision it simply failed to read.
    const { paths } = await isolatedPaths();
    const report = await reviewProductReadiness(paths, [MODEL_DIMENSION], null);
    expect(report.items[0]?.state).toBe("unknown");
  });
});

/**
 * Run `body` with the fixture credential's source present, always clearing it.
 *
 * The env var IS the thing under test in these cases — `available` means the
 * source resolves — so it is set explicitly rather than assumed, and removed in
 * `finally` so one case cannot leak availability into the next.
 */
async function withSourcePresent(body: () => Promise<void>): Promise<void> {
  process.env.FIXTURE_KEY = "present";
  try { await body(); } finally { delete process.env.FIXTURE_KEY; }
}

/** Review the model dimension with a bound credential and the given requirements. */
async function reviewWithProviders(
  requirements: readonly ProviderRequirementV2[],
): Promise<string | undefined> {
  const { paths } = await isolatedPaths();
  await writeFile(path.join(paths.configRoot, CREDENTIALS_FILE), registryText("model-key"), "utf8");
  const report = await reviewProductReadiness(paths, [MODEL_DIMENSION], new Set(), requirements);
  return report.items[0]?.state;
}

/** Review the model dimension against one requirement, scoped to this project. */
async function reviewWithRequirement(requirement: ProviderRequirementV2): Promise<string | undefined> {
  const { paths, root } = await isolatedPaths();
  await writeFile(path.join(paths.configRoot, CREDENTIALS_FILE), registryText("model-key"), "utf8");
  const report = await reviewProductReadiness(paths, [MODEL_DIMENSION], new Set(), [requirement], root);
  return report.items[0]?.state;
}

/** A provider requirement that needs `model-ready`, allowing one package pin. */
function requiringProvider(pin: string, grantKinds: string[] = []) {
  return {
    roleId: "model", disposition: "optional" as const, capabilityId: "cap.model",
    capabilityContractDigest: `sha256:${"0".repeat(64)}`,
    allowedProviderPins: [pin], requiredReadinessDimensions: ["model-ready"],
    requestedGrantKinds: grantKinds, fallbackPolicy: { kind: "refuse" as const },
  } as unknown as ProviderRequirementV2;
}

describe("provider backing", () => {
  it("reports PROVIDER MISSING when credentials resolve but no allowed package is installed", async () => {
    // The gap a credential check alone cannot see: everything about the
    // credential is fine and the call still cannot be made.
    await withSourcePresent(async () => {
      expect(await reviewWithProviders([requiringProvider(`sha256:${"a".repeat(64)}`)]))
        .toBe("provider-missing");
    });
  });

  it("does NOT mask a missing credential with the provider gap", async () => {
    // Ordering matters: reporting the provider problem while the credential is
    // also absent would send an operator to fix the second problem first.
    const { paths } = await isolatedPaths();
    const report = await reviewProductReadiness(
      paths, [MODEL_DIMENSION], new Set(), [requiringProvider(`sha256:${"a".repeat(64)}`)]);
    expect(report.items[0]?.state).toBe("not-configured");
  });

  it("never reports a provider gap for a dimension no requirement names", async () => {
    await withSourcePresent(async () => {
      // Nothing declared that this capability needs a provider, so there is no
      // gap to report — silence here, not a manufactured problem.
      expect(await reviewWithProviders([])).toBe("available");
    });
  });
});

describe("grant backing", () => {
  it("reports GRANT MISSING when credentials and provider are fine but nothing is granted", async () => {
    // The last prerequisite reached on its own: no pins declared means no
    // install constraint, so the review gets past the provider leg and the
    // ungranted access is what remains.
    await withSourcePresent(async () => {
      const requirement = requiringProvider("", ["network"]);
      (requirement as { allowedProviderPins: string[] }).allowedProviderPins = [];
      expect(await reviewWithRequirement(requirement)).toBe("grant-missing");
    });
  });

  it("reports the PROVIDER gap before the grant gap when both are open", async () => {
    // Dependency order, asserted rather than assumed: fixing grants first would
    // leave the operator hitting the provider problem immediately after.
    await withSourcePresent(async () => {
      expect(await reviewWithRequirement(requiringProvider(`sha256:${"a".repeat(64)}`, ["network"])))
        .toBe("provider-missing");
    });
  });

  it("reports no grant gap when the requirement asks for none", async () => {
    await withSourcePresent(async () => {
      expect(await reviewWithProviders([])).toBe("available");
    });
  });
});

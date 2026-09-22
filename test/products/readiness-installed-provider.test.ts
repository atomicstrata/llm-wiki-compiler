/**
 * @file test/products/readiness-installed-provider.test.ts
 * @description Readiness over a REALLY installed provider: a requirement whose
 * allowed pin is installed must not report `provider-missing`.
 *
 * IT NEEDS A REAL INSTALL, which is the whole reason this gap survived. Every
 * existing readiness suite supplies requirements whose allowed pins are literals
 * no install ever matched, so the comparison returned false for the right answer
 * and the wrong reason — and would have kept passing however the two sides were
 * compared.
 *
 * REACHING THE PROVIDER CHECK TAKES SETUP, and the first attempt at this file
 * did not: `provider-missing` is only reported once the dimension's CREDENTIAL
 * resolves `available`, so a dimension with no credential slot returns
 * `undeclared` and every case passes without the provider comparison ever
 * running. The registry write and the env var below are what make these cases
 * measure the thing they name.
 *
 * THE TWO DIGESTS ARE NOT THE SAME VALUE. A pack names a provider by the digest
 * of a PIN (package + manifest + one capability); installed state records the
 * PACKAGE digest. Comparing them directly can never match, so a correctly
 * installed provider reported as missing looked exactly like one that was not
 * installed at all.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readinessRequirement, installReadinessProvider, reviewReadinessDimension } from "./readiness-provider-fixture.js";
import {
  installResolutionFixture, removeResolutionFixture, type ResolutionFixture,
} from "../capability-providers/resolution-fixture.js";
import type { ProviderRequirementV2 } from "../../src/operations-packs/types.js";
import type { ProductReadinessDimensionV2 } from "../../src/operations-packs/types.js";

const DIMENSION = "model-ready";
const CREDENTIALS_FILE = "provider-credentials-v1.json";

/** A registry binding the dimension's slot to an env var that IS set. */
function registryText(): string {
  return JSON.stringify({
    schemaVersion: 1,
    handles: {
      "handle-1": {
        schemaVersion: 1, handleId: "handle-1", slotId: "model-key",
        source: { kind: "environment", variable: "READINESS_FIXTURE_KEY" },
        allowedBrokerIds: ["model"],
      },
    },
  });
}

let fixture: ResolutionFixture | undefined;
afterEach(async () => {
  if (fixture) await removeResolutionFixture(fixture);
  fixture = undefined;
});

const dimension = {
  dimensionId: DIMENSION, credentialSlotId: "model-key",
  summaryKey: "fixture.model.affects", degradedSummaryKey: "fixture.model.degraded",
} as unknown as ProductReadinessDimensionV2;

/** A requirement whose allowed pin is the digest the caller supplies. */
function requirementFor(pinDigest: string): ProviderRequirementV2 {
  return readinessRequirement(pinDigest, DIMENSION, "refuse");
}

/** Install a development provider and review readiness against a given pin. */
async function reviewWith(pinDigestOf: (installed: { providerPinDigest: string; packageDigest: string }) => string) {
  fixture = await installResolutionFixture();
  const installed = await installReadinessProvider(fixture, "readiness-provider", "1.4.0");
  // Credential FIRST: without an available credential the review never reaches
  // the provider comparison these cases exist to measure.
  process.env.READINESS_FIXTURE_KEY = "present";
  await writeFile(path.join(fixture.paths.configRoot, CREDENTIALS_FILE), registryText(), "utf8");
  return reviewReadinessDimension(fixture.paths, dimension, requirementFor(pinDigestOf(installed)));
}

describe("readiness over an installed provider", () => {
  it("finds the installed provider when the allowed PIN names it", async () => {
    // Asserted POSITIVELY rather than as "not provider-missing": the negative
    // form also passes for `undeclared`, which is exactly how the first version
    // of this case passed while measuring nothing.
    const item = await reviewWith((installed) => installed.providerPinDigest);
    expect(item?.state).not.toBe("provider-missing");
    expect(item?.state).not.toBe("undeclared");
  });

  it("DOES report provider-missing for a pin that is genuinely not installed", async () => {
    // The complement: without it, a check that never reports missing would pass
    // the case above for no reason at all.
    const item = await reviewWith(() => `sha256:${"b".repeat(64)}`);
    expect(item?.state).toBe("provider-missing");
  });

  it("reports missing when the requirement names the PACKAGE digest instead", async () => {
    // Pins the distinction directly: the package digest is a real digest of a
    // real installed package, and it is still not a pin.
    const item = await reviewWith((installed) => installed.packageDigest);
    expect(item?.state).toBe("provider-missing");
  });
});

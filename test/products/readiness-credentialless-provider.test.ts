/**
 * @file test/products/readiness-credentialless-provider.test.ts
 * @description Readiness for a dimension with NO credential slot that a
 * provider requirement names — the shape of a local extraction provider.
 *
 * WHAT THIS EXISTED TO END: with an ingest-configured AutoSci package active,
 * `llmwiki product status` reported "declares NO optional capabilities". Two
 * gaps compounded: the pack declared no dimension (fixed in the package), and a
 * dimension WITHOUT a credential slot short-circuited to `undeclared` before
 * the provider comparison ever ran — so even a declared dimension would have
 * reported nothing about the one thing most likely to be missing.
 *
 * `undeclared` REMAINS for what it was for: a legacy bare slug that declares no
 * way to be checked AND that no requirement names. The last case pins that it
 * did not silently widen.
 */

import { afterEach, describe, expect, it } from "vitest";
import { reviewProductReadiness } from "../../src/products/readiness.js";
import { readinessRequirement, installReadinessProvider, reviewReadinessDimension } from "./readiness-provider-fixture.js";
import { installDevProvider } from "../../src/capability-providers/host/install.js";
import { devGrantScope, issueDevProviderGrant } from "../../src/capability-providers/host/grant.js";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  devInstallMaterial, installResolutionFixture, removeResolutionFixture, type ResolutionFixture,
} from "../capability-providers/resolution-fixture.js";
import type {
  ProductReadinessDimensionV2, ProviderRequirementV2,
} from "../../src/operations-packs/types.js";

const DIMENSION = "extractor-provider";

let fixture: ResolutionFixture | undefined;
let scratch: ResolutionFixture | undefined;
afterEach(async () => {
  if (fixture) await removeResolutionFixture(fixture);
  if (scratch) await removeResolutionFixture(scratch);
  fixture = undefined;
  scratch = undefined;
});

/** The AutoSci shape: a dimension declaring descriptions but NO credential slot. */
const dimension = {
  dimensionId: DIMENSION,
  summaryKey: "fixture.extractor.affects", degradedSummaryKey: "fixture.extractor.degraded",
} as unknown as ProductReadinessDimensionV2;

/** A requirement whose allowed pin is the digest the caller supplies. */
function requirementFor(pinDigest: string): ProviderRequirementV2 {
  return readinessRequirement(pinDigest, DIMENSION, "none");
}

/** Install a real provider, then review the credential-less dimension. */
async function reviewWith(pinDigestOf: (installed: { providerPinDigest: string }) => string) {
  fixture = await installResolutionFixture();
  const installed = await installReadinessProvider(fixture, "credless-provider", "1.0.0");
  return reviewReadinessDimension(fixture.paths, dimension, requirementFor(pinDigestOf(installed)));
}

/**
 * Install a real provider and mint a fresh project root to review it within.
 * Returns `paths` so callers never touch the module-level `fixture`, which a
 * cross-function assignment leaves control-flow-typed as possibly undefined.
 */
async function installedProviderInProject(name: string) {
  fixture = await installResolutionFixture();
  const installed = await installReadinessProvider(fixture, name, "1.0.0");
  const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), `${name}-`)));
  return { installed, projectRoot, paths: fixture.paths };
}

/** A requirement that ALSO asks for a project grant kind, as AutoSci ingest does. */
function grantNeedingRequirement(pinDigest: string): ProviderRequirementV2 {
  return { ...requirementFor(pinDigest), requestedGrantKinds: ["source-read"] } as ProviderRequirementV2;
}

/** The source.read atom an operator's grant carries for retained-source reads. */
const SOURCE_READ_ATOM = {
  kind: "source.read", brokerId: null, operation: "read", target: null, method: null,
  credentialSlotId: null, credentialHandleId: null, effectClass: null,
  inputKind: "source-evidence", toolId: null,
} as const;

describe("a requirement asking for a grant kind is NOT available without it", () => {
  it("reports GRANT-MISSING with the provider installed but no project grant", async () => {
    // The false-available defect: an empty requestedGrantKinds skipped the
    // grant check entirely, so a provider whose every invocation would refuse
    // was reported available. The pack now declares source.read, and this pins
    // that the declaration is CHECKED against this project.
    const { installed, projectRoot, paths } = await installedProviderInProject("granted-provider");
    const report = await reviewProductReadiness(
      paths, [dimension], new Set(),
      [grantNeedingRequirement(installed.providerPinDigest)], projectRoot,
    );
    expect(report.items[0]?.state).toBe("grant-missing");
  });

  it("reports AVAILABLE once THIS project holds a source.read grant", async () => {
    const { installed, projectRoot, paths } = await installedProviderInProject("granted-provider");
    await issueDevProviderGrant(paths, {
      pin: installed.pin, projectRoot, grantId: "readiness-grant",
      scope: devGrantScope([SOURCE_READ_ATOM as never]),
    });
    const report = await reviewProductReadiness(
      paths, [dimension], new Set(),
      [grantNeedingRequirement(installed.providerPinDigest)], projectRoot,
    );
    expect(report.items[0]?.state).toBe("available");
  });
});

describe("a proposal-only requirement (no grant kinds) still needs a grant RECORD", () => {
  // Discover's acquirer requests NO grant kind, yet its provider cannot launch
  // without a project grant — a launch constructs its authority from a grant
  // record even when that record spends nothing. Modeling grant PRESENCE
  // independently of requested KINDS is what these two cases pin: an empty
  // requestedGrantKinds must not report `available` for a project that has
  // granted nothing. Reverting the grantSatisfies change (empty kinds → true)
  // reddens the first case; the empty-scope grant is what flips the second.
  it("reports GRANT-MISSING installed but with no project grant at all", async () => {
    const { installed, projectRoot, paths } = await installedProviderInProject("propose-only");
    const report = await reviewProductReadiness(
      paths, [dimension], new Set(),
      [requirementFor(installed.providerPinDigest)], projectRoot,
    );
    expect(report.items[0]?.state).toBe("grant-missing");
  });

  it("reports AVAILABLE once THIS project holds an EMPTY-scope grant for it", async () => {
    // The empty-scope grant is exactly what discover issues: authority to launch
    // carrying no spend. It is a RECORD bound to the pin, which is what a launch
    // needs — and its presence is the only thing that flips this to available.
    const { installed, projectRoot, paths } = await installedProviderInProject("propose-only");
    await issueDevProviderGrant(paths, {
      pin: installed.pin, projectRoot, grantId: "propose-grant",
      scope: devGrantScope([]),
    });
    const report = await reviewProductReadiness(
      paths, [dimension], new Set(),
      [requirementFor(installed.providerPinDigest)], projectRoot,
    );
    expect(report.items[0]?.state).toBe("available");
  });
});

/** Two distinct installed pins, with the project grant issued exclusively to A. */
async function pairWithGrantForA() {
  fixture = await installResolutionFixture();
  const installedA = await installReadinessProvider(fixture, "provider-a", "1.0.0");
  const installedB = await installReadinessProvider(fixture, "provider-b", "2.0.0");
  expect(installedB.providerPinDigest).not.toBe(installedA.providerPinDigest);
  const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), "cross-grant-")));
  await issueDevProviderGrant(fixture.paths, {
    pin: installedA.pin, projectRoot, grantId: "a-only-grant", scope: devGrantScope([SOURCE_READ_ATOM as never]),
  });
  return { installedA, installedB, projectRoot, paths: fixture.paths };
}

describe("a grant binds ONE provider, and readiness must spend it on that one", () => {
  it("reports GRANT-MISSING for provider B when only provider A holds the grant", async () => {
    // The cross-provider probe: unioning grant kinds across the project spent
    // A's grant on B's requirement — a false `available` about a call the
    // runtime, which binds authority to the exact pin, would refuse.
    const { installedB, projectRoot, paths } = await pairWithGrantForA();
    // The probe is only a probe if the two providers ARE two: identical
    // payloads produce identical pins, and a requirement allowing "B" would
    // then legitimately accept A's grant.
    const report = await reviewProductReadiness(
      paths, [dimension], new Set(),
      [grantNeedingRequirement(installedB.providerPinDigest)], projectRoot,
    );
    expect(report.items[0]?.state).toBe("grant-missing");
  });

  it("reports AVAILABLE for provider A, whose grant it is", async () => {
    // The complement, in the same two-provider world: the pin-bound evaluation
    // must not refuse the provider the grant actually names.
    const { installedA, projectRoot, paths } = await pairWithGrantForA();
    const report = await reviewProductReadiness(
      paths, [dimension], new Set(),
      [grantNeedingRequirement(installedA.providerPinDigest)], projectRoot,
    );
    expect(report.items[0]?.state).toBe("available");
  });
});


describe("a credential-less, requirement-named dimension is checkable", () => {
  it("reports AVAILABLE when the named provider is installed", async () => {
    const item = await reviewWith((installed) => installed.providerPinDigest);
    expect(item?.state).toBe("available");
  });

  it("reports PROVIDER-MISSING when the named pin is not installed", async () => {
    // The state that was unreachable: `undeclared` short-circuited before the
    // provider comparison, so this exact answer could never be given.
    const item = await reviewWith(() => `sha256:${"b".repeat(64)}`);
    expect(item?.state).toBe("provider-missing");
  });

  it("still reports UNDECLARED for a dimension nothing names", async () => {
    // The boundary of the change: no credential slot AND no requirement naming
    // it means there is genuinely no way to check it.
    fixture = await installResolutionFixture();
    const report = await reviewProductReadiness(fixture.paths, [dimension], new Set(), []);
    expect(report.items[0]?.state).toBe("undeclared");
  });
});

describe("two requirements for one dimension do not lend each other halves", () => {
  it("stays un-AVAILABLE when installed A is grantless and only absent B holds the grant", async () => {
    // The split-requirement probe: folding install and grant checks
    // independently let A satisfy the install half and B the grant half —
    // `available` for a dimension NEITHER provider can serve.
    fixture = await installResolutionFixture();
    const a = await devInstallMaterial(fixture, "provider-a", "1.0.0");
    const installedA = await installDevProvider(fixture.paths, { ...a, approveExecution: true });
    // B's pin is minted in a SCRATCH store: the store under review holds B's
    // grant while B is genuinely absent from its installed state.
    scratch = await installResolutionFixture();
    const b = await devInstallMaterial(scratch, "provider-b", "2.0.0");
    const installedB = await installDevProvider(scratch.paths, { ...b, approveExecution: true });
    expect(installedB.providerPinDigest).not.toBe(installedA.providerPinDigest);
    const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), "split-grant-")));
    await issueDevProviderGrant(fixture.paths, {
      pin: installedB.pin, projectRoot, grantId: "b-only-grant",
      scope: devGrantScope([SOURCE_READ_ATOM as never]),
    });
    const report = await reviewProductReadiness(
      fixture.paths, [dimension], new Set(),
      [
        grantNeedingRequirement(installedA.providerPinDigest),
        grantNeedingRequirement(installedB.providerPinDigest),
      ],
      projectRoot,
    );
    expect(report.items[0]?.state).toBe("grant-missing");
  });
});

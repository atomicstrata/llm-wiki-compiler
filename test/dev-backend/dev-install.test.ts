/**
 * @file test/dev-backend/dev-install.test.ts
 * @description The development install helper: the pin it derives is the pin
 * the PLATFORM'S OWN RESOLVER resolves.
 *
 * THE LOAD-BEARING CASE IS RESOLUTION, NOT SHAPE. Asserting the pin's fields
 * would only restate the derivation; it would pass just as well if the digest
 * named a provider that was never installed. So the pin is fed to
 * `resolveProviderPin` — the same function the runtime resolves a pack's
 * `defaultProviderPin` through — and must come back RESOLVED. That is the only
 * evidence that a pack declaring this digest would actually reach this package.
 *
 * APPROVAL IS A SEPARATE DECISION and this proves it is really separate: the
 * same install, without approval, resolves REFUSED. A helper that quietly
 * approved on install would pass every other case here.
 */

import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest } from "../../src/profile/templates/signing/canonical.js";
import { resolveProviderPin } from "../../src/capability-providers/packages/resolve.js";
import { installDevProvider } from "../../src/capability-providers/host/install.js";
import {
  devInstallMaterial, installResolutionFixture, removeResolutionFixture, type ResolutionFixture,
} from "../capability-providers/resolution-fixture.js";

let fixture: ResolutionFixture | undefined;
afterEach(async () => {
  if (fixture) await removeResolutionFixture(fixture);
  fixture = undefined;
});

/** Install one development provider through the helper under test. */
async function install(approveExecution: boolean) {
  fixture = await installResolutionFixture();
  const { sourceRoot, payload } = await devInstallMaterial(fixture, "dev-provider", "1.2.0");
  const installed = await installDevProvider(fixture.paths, { sourceRoot, payload, approveExecution });
  return { installed, fixture };
}

describe("installing a development provider yields a usable pin", () => {
  it("derives a pin the PLATFORM'S resolver resolves", async () => {
    const { installed, fixture: f } = await install(true);
    const resolution = await resolveProviderPin(installed.pin, f.context);
    // Not a shape assertion: this is the same resolver a pack's declared pin
    // travels through, so RESOLVED means a pack naming this digest reaches
    // this package.
    // The token is deliberately non-serializable, so the diagnostic reads the
    // refusal detail rather than the whole resolution.
    expect(resolution.kind, resolution.kind === "unavailable" ? resolution.detail : "").toBe("resolved");
  });

  it("reports the digest a pack must declare, derived from the package itself", async () => {
    const { installed } = await install(true);
    // Derived, never supplied: recomputing it from the returned pin must agree,
    // so a pin field the helper filled in by hand would disagree here.
    expect(installed.providerPinDigest).toBe(canonicalDigest(installed.pin));
    expect(installed.approvedForExecution).toBe(true);
  });

  it("REFUSES to resolve an installed provider whose execution was never approved", async () => {
    // The complement that keeps approval honest: without it the same install
    // resolves refused, so the helper cannot be silently approving.
    const { installed, fixture: f } = await install(false);
    const resolution = await resolveProviderPin(installed.pin, f.context);
    expect(resolution.kind).toBe("unavailable");
    expect(installed.approvedForExecution).toBe(false);
  });
});

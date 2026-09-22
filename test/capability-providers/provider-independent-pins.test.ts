/**
 * @file test/capability-providers/provider-independent-pins.test.ts
 * @description Side-by-side exact-version tests proving one product's local
 * pin does not rewrite or replace another installed provider selection.
 */
import { afterEach, describe, expect, it } from "vitest";
import { approveLocalProviderExecution } from "../../src/capability-providers/packages/local-install.js";
import { resolveProviderPin } from "../../src/capability-providers/packages/resolve.js";
import { installIndependentLocalFixture, installResolutionFixture, removeResolutionFixture, type ResolutionFixture } from "./resolution-fixture.js";

const fixtures: ResolutionFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map(removeResolutionFixture)));

describe("provider independent exact pins", () => {
  it("resolves retained signed and local versions independently", async () => {
    const fixture = await trackedFixture();
    const localPin = await installIndependentLocalFixture(fixture);
    await approveLocalProviderExecution(fixture.paths, {
      packageDigest: localPin.packageDigest, confirmed: true,
    });
    const [signed, local] = await Promise.all([
      resolveProviderPin(fixture.pin, fixture.context), resolveProviderPin(localPin, fixture.context),
    ]);
    expect(signed).toMatchObject({ kind: "resolved", pin: fixture.pin });
    expect(local).toMatchObject({ kind: "resolved", pin: localPin });
    expect(fixture.pin.packageDigest).not.toBe(localPin.packageDigest);
  });
});

/** Create and retain one fixture for deterministic asynchronous cleanup. */
async function trackedFixture(): Promise<ResolutionFixture> {
  const fixture = await installResolutionFixture();
  fixtures.push(fixture);
  return fixture;
}

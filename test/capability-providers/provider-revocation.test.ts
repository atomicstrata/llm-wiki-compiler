/**
 * @file test/capability-providers/provider-revocation.test.ts
 * @description Current accepted revocation-evidence tests for Task 4's exact
 * resolver, including stale accepted evidence and known revocation refusal.
 */
import { rename } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProviderPin } from "../../src/capability-providers/packages/resolve.js";
import { readProviderSourcesState, writeProviderSourcesState } from "../../src/capability-providers/packages/state-store.js";
import { installResolutionFixture, removeResolutionFixture, type ResolutionFixture } from "./resolution-fixture.js";

const fixtures: ResolutionFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map(removeResolutionFixture)));

describe("provider revocation evidence", () => {
  it("labels expired but still bounded accepted evidence as stale-accepted", async () => {
    let now = new Date("2026-07-17T12:00:00Z");
    const fixture = await trackedFixture(() => now);
    now = new Date("2026-07-19T00:00:00Z");
    await expect(resolveProviderPin(fixture.pin, fixture.context)).resolves.toMatchObject({
      kind: "resolved", revocationEvidence: "stale-accepted",
    });
  });

  it("refuses a signed remote provider after accepted evidence exceeds seven days", async () => {
    let now = new Date("2026-07-17T12:00:00Z");
    const fixture = await trackedFixture(() => now);
    now = new Date("2026-07-24T00:00:01Z");
    await expect(resolveProviderPin(fixture.pin, fixture.context)).resolves.toMatchObject({
      kind: "unavailable", code: "provider-revocation-evidence-stale",
    });
  });

  it("refuses a package revoked by the currently accepted continuity state", async () => {
    const fixture = await trackedFixture();
    const sources = await readProviderSourcesState(fixture.paths);
    const source = sources.sources.official;
    await writeProviderSourcesState(fixture.paths, {
      schemaVersion: 1,
      sources: { official: { ...source, publisherPins: { ...source.publisherPins, revokedPackages: [fixture.pin.packageDigest] } } },
    });
    await expect(resolveProviderPin(fixture.pin, fixture.context)).resolves.toMatchObject({
      kind: "unavailable", code: "provider-revoked",
    });
  });

  it("parks when accepted revocation authority becomes unavailable", async () => {
    const fixture = await trackedFixture();
    await rename(fixture.paths.sourcesFile, `${fixture.paths.sourcesFile}.missing`);
    await expect(resolveProviderPin(fixture.pin, fixture.context)).resolves.toMatchObject({
      kind: "unavailable", code: "provider-store-unavailable",
    });
  });
});

/** Create and retain one fixture for deterministic asynchronous cleanup. */
async function trackedFixture(nowForTest?: () => Date): Promise<ResolutionFixture> {
  const fixture = await installResolutionFixture(nowForTest);
  fixtures.push(fixture);
  return fixture;
}

/**
 * @file test/products/provider-paths-cross-bundle.test.ts
 * @description A paths object authorized by ONE copy of the shipped module is
 * honoured by ANOTHER copy — the topology of `dist/index.js` beside
 * `dist/cli.js`.
 *
 * WHAT THIS EXISTED TO END: the documented CLI provider route could not work.
 * An operator's module imports the library (`dist/index.js`) and resolves the
 * operator paths there; the CLI is a SEPARATE bundle with its own copy of the
 * authorization WeakMap, so the object was refused before any launch —
 * `provider-grant-missing: provider grant store is unavailable`. Every test
 * imports repository source and has ONE module instance, which is exactly why
 * eight review rounds and a green suite never saw it.
 *
 * TWO REAL MODULE INSTANCES, not a simulation: the built artifact is imported
 * twice with distinct cache-busting queries, giving two module graphs with two
 * WeakMaps — the same separation the two bundles have. A test importing source
 * would have one instance and prove nothing.
 *
 * ADOPTION MUST NOT BE A HOLE: the doctored-object case pins that only the
 * byte-identical canonical object crosses; one changed field still refuses.
 */

import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const DIST = path.resolve("dist/index.js");
const SAVED = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };

beforeEach(async () => {
  // Isolated operator roots, owner-private as authorization requires — the
  // canonical roots FOR THIS PROCESS, without touching the operator's real ones.
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "cross-bundle-")));
  await mkdir(path.join(base, "config"), { mode: 0o700 });
  await mkdir(path.join(base, "cache"), { mode: 0o700 });
  process.env.XDG_CONFIG_HOME = path.join(base, "config");
  process.env.XDG_CACHE_HOME = path.join(base, "cache");
});
afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** One fresh module instance of the built artifact. */
async function bundleInstance(tag: string): Promise<unknown> {
  return import(`${pathToFileURL(DIST).href}?instance=${tag}`);
}

/**
 * A pin every field-shape check accepts, so the paths gate is what each case
 * measures. The FIRST version passed `pin: {}` — and pin validation runs
 * BEFORE the paths assert, so both cases failed early on the pin and the
 * adoption case would have stayed green with adoption broken entirely.
 */
const WELLFORMED_PIN = {
  schemaVersion: 1, coordinate: "local/atomicstrata/research@1.0.0",
  providerId: "research", providerVersion: "1.0.0",
  packageDigest: `sha256:${"a".repeat(64)}`, manifestDigest: `sha256:${"b".repeat(64)}`,
  capabilityId: "discover", capabilityContractVersion: "discover-v1",
  capabilitySchemaDigest: `sha256:${"c".repeat(64)}`,
};

describe("provider paths across a bundle boundary", () => {
  it("honours the canonical object authorized by a sibling module instance", async () => {
    const a = await bundleInstance("a") as { resolveAuthorizedProviderPaths: () => Promise<object> };
    const b = await bundleInstance("b") as {
      resolveAuthorizedProviderPaths: () => Promise<object>;
      derivePinForPayload: unknown;
      issueDevProviderGrant: (paths: object, request: object) => Promise<object>;
    };
    const fromA = await a.resolveAuthorizedProviderPaths();
    // The grant path is the exact leg that refused in production: issuing reads
    // AND writes the grant store, both behind assertAuthorizedProviderPaths.
    // Asserted as OUTRIGHT SUCCESS — the whole verb completes across the
    // boundary, so there is no weaker error-shape claim to hide behind.
    await expect(
      b.issueDevProviderGrant(fromA, { pin: WELLFORMED_PIN, projectRoot: process.cwd(), grantId: "cross-grant" }),
    ).resolves.toMatchObject({ grantId: "cross-grant" });
  }, 60_000);

  it("still refuses the same object with ONE doctored field", async () => {
    const a = await bundleInstance("c") as { resolveAuthorizedProviderPaths: () => Promise<object> };
    const b = await bundleInstance("d") as {
      issueDevProviderGrant: (paths: object, request: object) => Promise<object>;
    };
    const fromA = await a.resolveAuthorizedProviderPaths();
    const forged = { ...fromA, installsFile: "/tmp/evil-installs.json" };
    await expect(
      b.issueDevProviderGrant(forged, { pin: WELLFORMED_PIN, projectRoot: process.cwd(), grantId: "evil-grant" }),
    ).rejects.toThrow(/operator root is unavailable/);
  }, 60_000);
});

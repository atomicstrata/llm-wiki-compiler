/**
 * @file test/profile-template-tap-refresh.test.ts
 * @description Offline signed-index refresh and continuity commit tests.
 */
import { rm, unlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { addTap } from "../src/profile/templates/taps/manage.js";
import { removeTap } from "../src/profile/templates/taps/manage.js";
import { readIndexCache, writeIndexCache } from "../src/profile/templates/taps/cache.js";
import type { TapPaths } from "../src/profile/templates/taps/paths.js";
import { refreshTap } from "../src/profile/templates/taps/refresh.js";
import { readTapState } from "../src/profile/templates/taps/state-store.js";
import { isolatedTapPaths, servesTemplateBytes, templateRegistryFixture, TAP_KEY } from "./fixtures/template-tap-runtime.js";
import { signedIndex } from "./fixtures/template-signing.js";

const roots: string[] = [];
async function setup(): Promise<{ paths: TapPaths; index: string }> {
  const paths = await isolatedTapPaths("llmwiki-refresh-", roots);
  await addTap(paths, { name: "official", indexUrl: "https://tap.example/index.json", key: TAP_KEY });
  return { paths, index: await templateRegistryFixture("index.json") };
}

async function expectCacheRepair(
  fixture: Awaited<ReturnType<typeof setup>>,
  damage: (leaf: string) => Promise<void>,
): Promise<void> {
  await refreshTap(fixture.paths, "official", servesTemplateBytes(fixture.index));
  const leaf = `${fixture.paths.cacheRoot}/indexes/official/1.json`;
  await damage(leaf);
  await expect(refreshTap(fixture.paths, "official", servesTemplateBytes(fixture.index))).resolves.toMatchObject({ sequence: 1 });
  expect(await readIndexCache(fixture.paths, "official", 1)).toContain('"sequence": 1');
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("template tap refresh", () => {
  it("accepts a verified snapshot, caches it, and advances continuity", async () => {
    const fixture = await setup();
    expect(await refreshTap(fixture.paths, "official", servesTemplateBytes(fixture.index))).toEqual({ tap: "official", sequence: 1, packages: 1, warnings: [] });
    const state = await readTapState(fixture.paths);
    expect(state.taps.official.publisherPins.highestSequence).toBe(1);
    expect(state.taps.official.publisherPins.coordinates).toHaveProperty("official/atomicstrata/team@1.0.0");
  });

  it("refuses tampered signed bytes without advancing state", async () => {
    const fixture = await setup();
    const tampered = fixture.index.replace('"sequence": 1', '"sequence": 2');
    await expect(refreshTap(fixture.paths, "official", servesTemplateBytes(tampered))).rejects.toThrow(/signature/);
    expect((await readTapState(fixture.paths)).taps.official.publisherPins.highestSequence).toBe(-1);
  });

  it("refuses replay after accepting a sequence", async () => {
    const fixture = await setup();
    await refreshTap(fixture.paths, "official", servesTemplateBytes(fixture.index));
    await expect(refreshTap(fixture.paths, "official", servesTemplateBytes(fixture.index))).rejects.toThrow(/rollback or replay/);
  });

  it("repairs missing accepted cache evidence from the exact signed sequence", async () => {
    await expectCacheRepair(await setup(), unlink);
  });

  it("repairs malformed accepted cache evidence from the exact signed sequence", async () => {
    await expectCacheRepair(await setup(), (leaf) => writeFile(leaf, "not-json"));
  });

  it("refuses a different same-sequence snapshot while repairing evidence", async () => {
    const fixture = await setup();
    await refreshTap(fixture.paths, "official", servesTemplateBytes(fixture.index));
    await unlink(`${fixture.paths.cacheRoot}/indexes/official/1.json`);
    const equivocation = JSON.stringify(signedIndex({ packages: [] }));
    await expect(refreshTap(fixture.paths, "official", servesTemplateBytes(equivocation))).rejects.toThrow(/accepted index digest/);
  });

  it("prunes the superseded index cache after the next sequence commits", async () => {
    const fixture = await setup();
    await refreshTap(fixture.paths, "official", servesTemplateBytes(fixture.index));
    const second = JSON.stringify(signedIndex({ sequence: 2 }));
    await refreshTap(fixture.paths, "official", servesTemplateBytes(second));
    await expect(readIndexCache(fixture.paths, "official", 1)).rejects.toThrow(/unavailable/);
    expect(await readIndexCache(fixture.paths, "official", 2)).toContain('"sequence":2');
  });

  it("retries cleanup of every superseded index on later refreshes", async () => {
    const fixture = await setup();
    await refreshTap(fixture.paths, "official", servesTemplateBytes(fixture.index));
    await refreshTap(fixture.paths, "official", servesTemplateBytes(JSON.stringify(signedIndex({ sequence: 2 }))));
    await writeIndexCache(fixture.paths, "official", 1, fixture.index);
    await refreshTap(fixture.paths, "official", servesTemplateBytes(JSON.stringify(signedIndex({ sequence: 3 }))));
    await expect(readIndexCache(fixture.paths, "official", 1)).rejects.toThrow(/unavailable/);
    await expect(readIndexCache(fixture.paths, "official", 2)).rejects.toThrow(/unavailable/);
    expect(await readIndexCache(fixture.paths, "official", 3)).toContain('"sequence":3');
  });

  it("does not overwrite a tap disabled while its network fetch is in flight", async () => {
    const fixture = await setup();
    const interleaved = servesTemplateBytes(fixture.index);
    interleaved.request = async () => {
      await removeTap(fixture.paths, "official");
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: (await import("node:stream")).Readable.from([fixture.index]),
      };
    };
    await expect(refreshTap(fixture.paths, "official", interleaved)).rejects.toThrow(/changed during refresh/);
    expect((await readTapState(fixture.paths)).taps.official.enabled).toBe(false);
  });
});

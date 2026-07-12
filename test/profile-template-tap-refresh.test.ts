/**
 * @file test/profile-template-tap-refresh.test.ts
 * @description Offline signed-index refresh and continuity commit tests.
 */
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { addTap } from "../src/profile/templates/taps/manage.js";
import { removeTap } from "../src/profile/templates/taps/manage.js";
import type { TapPaths } from "../src/profile/templates/taps/paths.js";
import { refreshTap } from "../src/profile/templates/taps/refresh.js";
import { readTapState } from "../src/profile/templates/taps/state-store.js";
import { isolatedTapPaths, servesTemplateBytes, templateRegistryFixture, TAP_KEY } from "./fixtures/template-tap-runtime.js";

const roots: string[] = [];
async function setup(): Promise<{ paths: TapPaths; index: string }> {
  const paths = await isolatedTapPaths("llmwiki-refresh-", roots);
  await addTap(paths, { name: "official", indexUrl: "https://tap.example/index.json", key: TAP_KEY });
  return { paths, index: await templateRegistryFixture("index.json") };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("template tap refresh", () => {
  it("accepts a verified snapshot, caches it, and advances continuity", async () => {
    const fixture = await setup();
    expect(await refreshTap(fixture.paths, "official", servesTemplateBytes(fixture.index))).toEqual({ tap: "official", sequence: 1, packages: 1 });
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

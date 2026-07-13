/**
 * @file test/profile-template-tap-state.test.ts
 * @description Authoritative tap-state parsing, confinement, and lifecycle tests.
 */
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addTap, forgetTap, listTaps, removeTap } from "../src/profile/templates/taps/manage.js";
import { resolveTapPaths, type TapPaths } from "../src/profile/templates/taps/paths.js";
import { readTapState, writeTapState } from "../src/profile/templates/taps/state-store.js";
import type { PublisherKey } from "../src/profile/templates/signing/types.js";

const roots: string[] = [];
const KEY: PublisherKey = {
  keyId: "tap-key-1",
  publicKey: "MCowBQYDK2VwAyEA+Zh7GM2+2PTzR+DGzIIMyf9RW3z8iPX+y0ToR7vFF7Q=",
};

async function paths(): Promise<TapPaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmwiki-taps-"));
  roots.push(root);
  return resolveTapPaths({ configRoot: path.join(root, "config"), cacheRoot: path.join(root, "cache") });
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("template tap lifecycle", () => {
  it("adds, lists, disables, and exactly re-enables without exposing key bytes", async () => {
    const store = await paths();
    await addTap(store, { name: "community", indexUrl: "https://tap.example/index.json", key: KEY });
    expect(await removeTap(store, "community")).toMatchObject({ enabled: false });
    await addTap(store, { name: "community", indexUrl: "https://tap.example/index.json", key: KEY });
    const listed = await listTaps(store);
    expect(listed).toMatchObject([{ name: "community", enabled: true, keyId: "tap-key-1" }]);
    expect(JSON.stringify(listed)).not.toContain(KEY.publicKey);
  });

  it("refuses re-adding a retained name with another origin or key", async () => {
    const store = await paths();
    await addTap(store, { name: "community", indexUrl: "https://tap.example/index.json", key: KEY });
    await removeTap(store, "community");
    await expect(addTap(store, { name: "community", indexUrl: "https://evil.example/index.json", key: KEY })).rejects.toThrow(/cannot be replaced/);
  });

  it("serializes concurrent additions without losing either tap", async () => {
    const store = await paths();
    await Promise.all([
      addTap(store, { name: "alpha", indexUrl: "https://alpha.example/index.json", key: KEY }),
      addTap(store, { name: "beta", indexUrl: "https://beta.example/index.json", key: KEY }),
    ]);
    expect((await listTaps(store)).map((tap) => tap.name)).toEqual(["alpha", "beta"]);
  });

  it("requires explicit consent to forget trust, then permits a fresh identity", async () => {
    const store = await paths();
    await addTap(store, { name: "community", indexUrl: "https://tap.example/index.json", key: KEY });
    await expect(forgetTap(store, "community", false)).rejects.toThrow(/requires --yes/);
    await forgetTap(store, "community", true);
    await addTap(store, { name: "community", indexUrl: "https://new.example/index.json", key: KEY });
    expect(await listTaps(store)).toMatchObject([{ name: "community", origin: "https://new.example" }]);
  });

  it("warns before monotonic coordinate history reaches its hard cap", async () => {
    const store = await paths();
    const state = await stateWithCoordinates(store, 8_000);
    await writeTapState(store, state);
    expect((await listTaps(store))[0].warnings.join(" ")).toMatch(/approaching.*8000\/10000/);
  });

  it("refuses an over-cap write with the scoped recovery command", async () => {
    const store = await paths();
    const state = await stateWithCoordinates(store, 10_001);
    await expect(writeTapState(store, state)).rejects.toThrow(/tap forget <name> --yes/);
    expect(Object.keys((await readTapState(store)).taps.community.publisherPins.coordinates)).toHaveLength(0);
  });
});

describe("template tap path conventions", () => {
  it("ignores relative XDG roots instead of resolving them under cwd", () => {
    const resolved = resolveTapPaths({ env: { XDG_CONFIG_HOME: ".config", XDG_CACHE_HOME: ".cache" }, home: "/home/test", platform: "linux" });
    expect(resolved.configRoot).toBe("/home/test/.config/llmwiki");
    expect(resolved.cacheRoot).toBe("/home/test/.cache/llmwiki/templates");
  });
});

function coordinates(count: number): Record<string, string> {
  const digest = `sha256:${"0".repeat(64)}`;
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`community/pub/pkg-${index}@1.0.0`, digest]));
}

async function stateWithCoordinates(store: TapPaths, count: number) {
  await addTap(store, { name: "community", indexUrl: "https://tap.example/index.json", key: KEY });
  const state = await readTapState(store);
  state.taps.community.publisherPins.coordinates = coordinates(count);
  return state;
}

describe("template tap state hardening", () => {
  it("rejects duplicate keys and malformed existing state", async () => {
    const store = await paths();
    await mkdir(store.configRoot, { recursive: true });
    await writeFile(store.stateFile, '{"schemaVersion":1,"schemaVersion":1,"taps":{}}');
    await expect(readTapState(store)).rejects.toThrow(/duplicate JSON key/);
  });

  it("refuses a symlinked state leaf without reading its target", async () => {
    const store = await paths();
    await mkdir(store.configRoot, { recursive: true });
    const victim = path.join(path.dirname(store.configRoot), "victim.json");
    await writeFile(victim, "secret");
    await symlink(victim, store.stateFile);
    await expect(readTapState(store)).rejects.toThrow(/unavailable/);
    expect(await readFile(victim, "utf8")).toBe("secret");
  });

  it("does not mutate malformed state during add", async () => {
    const store = await paths();
    await mkdir(store.configRoot, { recursive: true });
    await writeFile(store.stateFile, "not-json");
    await expect(addTap(store, { name: "community", indexUrl: "https://tap.example/index.json", key: KEY })).rejects.toThrow();
    expect(await readFile(store.stateFile, "utf8")).toBe("not-json");
  });

  it("round-trips signed key-history ids containing non-slug punctuation", async () => {
    const store = await paths();
    await addTap(store, { name: "community", indexUrl: "https://tap.example/index.json", key: KEY });
    const state = await readTapState(store);
    state.taps.community.publisherPins.keyHistory["publisher:key.v1"] = { publisher: "publisher", publicKey: KEY.publicKey };
    await writeTapState(store, state);
    expect((await readTapState(store)).taps.community.publisherPins.keyHistory).toHaveProperty("publisher:key.v1");
  });

  it("refuses a symlinked config root before touching its target", async () => {
    const store = await paths();
    const outside = path.join(path.dirname(store.configRoot), "outside");
    await mkdir(outside);
    await symlink(outside, store.configRoot);
    await expect(addTap(store, { name: "community", indexUrl: "https://tap.example/index.json", key: KEY })).rejects.toThrow(/real directory/);
    await expect(readFile(path.join(outside, "template-taps.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

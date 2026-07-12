/**
 * @file test/profile-template-tap-state.test.ts
 * @description Authoritative tap-state parsing, confinement, and lifecycle tests.
 */
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addTap, listTaps, removeTap } from "../src/profile/templates/taps/manage.js";
import { resolveTapPaths, type TapPaths } from "../src/profile/templates/taps/paths.js";
import { readTapState } from "../src/profile/templates/taps/state-store.js";
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
});

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

  it("refuses a symlinked config root before touching its target", async () => {
    const store = await paths();
    const outside = path.join(path.dirname(store.configRoot), "outside");
    await mkdir(outside);
    await symlink(outside, store.configRoot);
    await expect(addTap(store, { name: "community", indexUrl: "https://tap.example/index.json", key: KEY })).rejects.toThrow(/real directory/);
    await expect(readFile(path.join(outside, "template-taps.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

/**
 * @file test/template-publish-init.test.ts
 * @description Workspace initialization is exclusive and atomic: keys are created
 * first and the manifest LAST, so an interrupted init never reports itself ready.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/profile/templates/publish/init.js";
import { resolveWorkspacePaths } from "../src/profile/templates/publish/workspace-paths.js";
import { readWorkspace } from "../src/profile/templates/publish/workspace-store.js";
import { publisherTempRoots } from "./fixtures/publisher-workspace.js";

const roots = publisherTempRoots();
afterEach(roots.cleanup);

async function target(): Promise<string> {
  return path.join(await roots.create("init"), "my-tap");
}

describe("publish init", () => {
  it("creates keys and a ready workspace at sequence 0", async () => {
    const dir = await target();

    const result = await initWorkspace(dir, { tap: "community", publisher: "acme" });

    const ws = await readWorkspace(resolveWorkspacePaths(dir));
    expect(ws).toMatchObject({ tap: "community", publisher: "acme", sequence: 0, packages: [], pending: [] });
    expect(ws.tapKey.keyId).toBe(result.tapKey.keyId);
    expect(ws.publisherKey.keyId).toBe(result.publisherKey.keyId);
    expect(result.fingerprints.tap).toMatch(/^[0-9a-f]{64}$/);
    expect(await readdir(path.join(dir, "keys"))).toContain(`tap-${result.tapKey.keyId}.key`);
  });

  it("derives deterministic default key ids", async () => {
    const dir = await target();

    const result = await initWorkspace(dir, {
      tap: "community", publisher: "acme", now: new Date("2026-07-14T00:00:00Z"),
    });

    expect(result.tapKey.keyId).toBe("community-tap-2026-07");
    expect(result.publisherKey.keyId).toBe("acme-publisher-2026-07");
  });

  it("refuses a non-empty directory", async () => {
    const dir = await target();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "stray.txt"), "x", "utf8");

    await expect(initWorkspace(dir, { tap: "community", publisher: "acme" }))
      .rejects.toThrow(/not empty/i);
  });

  it("refuses to reinitialize an existing workspace", async () => {
    const dir = await target();
    await initWorkspace(dir, { tap: "community", publisher: "acme" });

    await expect(initWorkspace(dir, { tap: "community", publisher: "acme" }))
      .rejects.toThrow(/not empty/i);
  });

  it("never writes private key bytes into the manifest", async () => {
    const dir = await target();
    const result = await initWorkspace(dir, { tap: "community", publisher: "acme" });

    const manifest = await readFile(path.join(dir, "workspace.json"), "utf8");
    const priv = (await readFile(path.join(dir, "keys", `tap-${result.tapKey.keyId}.key`), "utf8")).trim();

    expect(priv.length).toBeGreaterThan(0);
    expect(manifest).not.toContain(priv);
  });

  it("refuses a non-slug tap or publisher", async () => {
    const dir = await target();

    await expect(initWorkspace(dir, { tap: "../evil", publisher: "acme" })).rejects.toThrow(/slug-safe/i);
  });
});

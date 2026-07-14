/**
 * @file test/template-publish-workspace.test.ts
 * @description The workspace parser is bounded and fail-closed, the store is confined
 * and atomic, and private keys are exclusively created, 0600, and never followed.
 */
import { readFile, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKeypairFile, publicKeyFingerprint, readPrivateKey } from "../src/profile/templates/publish/keystore.js";
import { parsePublisherWorkspace } from "../src/profile/templates/publish/workspace-parse.js";
import type { WorkspacePaths } from "../src/profile/templates/publish/workspace-paths.js";
import { readWorkspace, writeWorkspace } from "../src/profile/templates/publish/workspace-store.js";
import type { PublisherWorkspace } from "../src/profile/templates/publish/workspace-types.js";
import { makeWorkspacePaths, outsideFile, publisherTempRoots } from "./fixtures/publisher-workspace.js";

const roots = publisherTempRoots();
afterEach(roots.cleanup);

async function workspacePaths(): Promise<WorkspacePaths> {
  return makeWorkspacePaths(await roots.create("ws"));
}

/** Plant a symlink inside the workspace that points at a file outside it. */
async function plantEscape(link: string, name: string, content: string): Promise<void> {
  const target = await outsideFile(await roots.create("evil"), name, content);
  await symlink(target, link);
}

function workspace(): PublisherWorkspace {
  return {
    schemaVersion: 1, tap: "community", publisher: "acme",
    tapKey: { keyId: "tap-1", publicKey: "AAAA" },
    publisherKey: { keyId: "pub-1", publicKey: "BBBB" },
    sequence: 0, packages: [], rotations: [], tapKeyRotations: [], revocations: [],
    pending: [], coordinates: {},
  };
}

describe("publisher workspace store", () => {
  it("round-trips through an atomic confined write", async () => {
    const paths = await workspacePaths();
    await writeWorkspace(paths, workspace());

    await expect(readWorkspace(paths)).resolves.toMatchObject({ tap: "community", sequence: 0 });
  });

  it("rejects duplicate JSON keys", () => {
    expect(() => parsePublisherWorkspace('{"schemaVersion":1,"tap":"a","tap":"b"}'))
      .toThrow(/duplicate JSON key/i);
  });

  it("rejects an unknown field", () => {
    expect(() => parsePublisherWorkspace(JSON.stringify({ ...workspace(), attacker: true })))
      .toThrow(/unexpected field/i);
  });

  it("rejects a non-slug tap identity", () => {
    expect(() => parsePublisherWorkspace(JSON.stringify({ ...workspace(), tap: "../escape" })))
      .toThrow(/slug-safe/i);
  });

  it("fails closed on a symlinked manifest", async () => {
    const paths = await workspacePaths();
    await plantEscape(paths.manifestFile, "evil.json", JSON.stringify(workspace()));

    await expect(readWorkspace(paths)).rejects.toThrow(/symlinked|unreadable/i);
  });
});

describe("publisher keystore", () => {
  it("creates a 0600 private key that round-trips and fingerprints", async () => {
    const paths = await workspacePaths();

    const pub = await createKeypairFile(paths, "tap-1", "tap");
    const priv = await readPrivateKey(paths, "tap", "tap-1");

    expect(pub.keyId).toBe("tap-1");
    expect(priv.keyId).toBe("tap-1");
    expect(publicKeyFingerprint(pub)).toMatch(/^[0-9a-f]{64}$/);
    const mode = (await stat(path.join(paths.keysDir, "tap-tap-1.key"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("never overwrites an existing private key", async () => {
    const paths = await workspacePaths();
    await createKeypairFile(paths, "tap-1", "tap");

    await expect(createKeypairFile(paths, "tap-1", "tap")).rejects.toThrow(/never overwritten/i);
  });

  it("refuses to read a symlinked private key", async () => {
    const paths = await workspacePaths();
    await plantEscape(path.join(paths.keysDir, "tap-evil.key"), "evil.key", "AAAA");

    await expect(readPrivateKey(paths, "tap", "evil")).rejects.toThrow(/symlinked|unreadable/i);
  });

  it("refuses a non-slug key id", async () => {
    const paths = await workspacePaths();

    await expect(createKeypairFile(paths, "../escape", "tap")).rejects.toThrow(/slug-safe/i);
  });

  it("keeps private bytes out of the public key file", async () => {
    const paths = await workspacePaths();
    await createKeypairFile(paths, "tap-1", "tap");

    const priv = (await readFile(path.join(paths.keysDir, "tap-tap-1.key"), "utf8")).trim();
    const pub = (await readFile(path.join(paths.keysDir, "tap-tap-1.pub"), "utf8")).trim();

    expect(pub).not.toContain(priv);
  });
});

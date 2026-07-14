/**
 * @file test/template-publish-build.test.ts
 * @description End-to-end publisher lifecycle, verified through the REAL consumer.
 *
 * The decisive cases are the ones a publisher-only test would miss:
 *  - a package published BEFORE a publisher rotation must still verify AFTER it
 *    (key continuity is not artifact continuity);
 *  - a revoked package must not appear in the built index (or build refuses itself);
 *  - a tap-rotating index must be signed by the SUCCESSOR key.
 */
import packageJson from "../package.json" with { type: "json" };
import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addPackage } from "../src/profile/templates/publish/add.js";
import { buildDistribution } from "../src/profile/templates/publish/build.js";
import {
  stageRevokePackage,
  stageRevokePublisherKey,
  stageRotatePublisherKey,
  stageRotateTapKey,
} from "../src/profile/templates/publish/lifecycle.js";
import { initWorkspace } from "../src/profile/templates/publish/init.js";
import { verifyPublisherDistribution } from "../src/profile/templates/publish/verify.js";
import { resolveWorkspacePaths, type WorkspacePaths } from "../src/profile/templates/publish/workspace-paths.js";
import { readWorkspace } from "../src/profile/templates/publish/workspace-store.js";
import { verifyBuiltDistribution } from "../src/profile/templates/publish/build-verify.js";
import type { PublisherWorkspace, WorkspacePackage } from "../src/profile/templates/publish/workspace-types.js";
import { parseSignedTapIndex } from "../src/profile/templates/signing/protocol.js";
import { publisherTempRoots } from "./fixtures/publisher-workspace.js";

const roots = publisherTempRoots();
afterEach(roots.cleanup);

const TEMPLATE = {
  schemaVersion: 1,
  templateId: "incident-response",
  version: "1.0.0",
  displayName: "Incident Response",
  publisher: "acme",
  sourceType: "remote",
  license: "MIT",
  minLlmwikiVersion: "1.0.0",
  profile: {
    schemaVersion: 1,
    profileId: "incident-response",
    displayName: "Incident Response",
    entities: {
      incidents: {
        directory: "wiki/incidents",
        titleField: "title",
        requiredFields: ["title"],
        fields: { title: { type: "string" } },
      },
    },
  },
};

interface Publisher {
  paths: WorkspacePaths;
  out: string;
  keyFile: string;
  add: () => Promise<string>;
  build: (force?: boolean) => Promise<{ sequence: number; packageCount: number }>;
}

/** A ready workspace plus an out-of-workspace output directory. */
async function publisher(): Promise<Publisher> {
  const root = await roots.create("pub");
  const dir = path.join(root, "workspace");
  const out = path.join(root, "dist");
  const init = await initWorkspace(dir, { tap: "community", publisher: "acme" });
  const paths = resolveWorkspacePaths(dir);
  return {
    paths,
    out,
    keyFile: path.join(paths.keysDir, `tap-${init.tapKey.keyId}.pub`),
    add: async () => {
      const file = path.join(root, "incident-response.json");
      await writeFile(file, JSON.stringify(TEMPLATE), "utf8");
      const result = await addPackage(paths, file, "1.0.0");
      return result.payloadDigest;
    },
    build: async (force = false) =>
      buildDistribution(paths, { out, expiresIn: "30d", force }),
  };
}

/**
 * Verify the built tree as a CONSUMER PINNED AT A PREVIOUS BUILD would: it walks the
 * rotation chain from its pinned keys, using the production verify and continuity
 * functions. The Slice A snapshot verifier cannot do this — it refuses rotation-bearing
 * indexes by design, because a latest-snapshot-only directory cannot prove continuity.
 */
async function verifyAsPinnedClient(p: Publisher, pinned: PublisherWorkspace) {
  const indexJson = await readFile(path.join(p.out, "index.json"), "utf8");
  const digestDir = path.join(p.out, "packages", "sha256");
  const files = await readdir(digestDir).catch(() => []);
  const packages = await Promise.all(files.map(async (file) => ({
    envelopeJson: await readFile(path.join(digestDir, file), "utf8"),
  }) as WorkspacePackage));
  return verifyBuiltDistribution(pinned, indexJson, packages, packageJson.version);
}

/** Verify the built tree exactly as the shipped Slice A verifier does. */
async function verifySnapshot(p: Publisher): Promise<void> {
  const ws = await readWorkspace(p.paths);
  await verifyPublisherDistribution(p.out, "community", ws.tapKey.keyId, p.keyFile);
}

describe("publisher build", () => {
  it("builds a verifiable distribution and commits the sequence last", async () => {
    const p = await publisher();
    await p.add();

    const result = await p.build();

    expect(result).toMatchObject({ sequence: 1, packageCount: 1 });
    await verifySnapshot(p);
    const ws = await readWorkspace(p.paths);
    expect(ws.sequence).toBe(1);
    expect(ws.lastBuild).toMatchObject({ sequence: 1 });
    expect(ws.lastBuild?.indexDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("emits exactly index.json and the content-addressed package", async () => {
    const p = await publisher();
    const digest = await p.add();
    await p.build();

    expect((await readdir(p.out)).sort()).toEqual(["index.json", "packages"]);
    const hex = digest.replace("sha256:", "");
    await expect(stat(path.join(p.out, "packages", "sha256", `${hex}.json`))).resolves.toBeDefined();
  });

  it("never publishes private keys into the output tree", async () => {
    const p = await publisher();
    await p.add();
    await p.build();

    const index = await readFile(path.join(p.out, "index.json"), "utf8");
    const privateKey = (await readFile(
      path.join(p.paths.keysDir, (await readdir(p.paths.keysDir)).find((f) => f.endsWith(".key"))!),
      "utf8",
    )).trim();

    expect(index).not.toContain(privateKey);
  });

  it("refuses an output directory inside the workspace", async () => {
    const p = await publisher();
    await p.add();

    await expect(buildDistribution(p.paths, {
      out: path.join(p.paths.root, "dist"), expiresIn: "30d",
    })).rejects.toThrow(/outside the publisher workspace/i);
  });

  it("refuses a no-change rebuild but allows --force", async () => {
    const p = await publisher();
    await p.add();
    await p.build();

    await expect(p.build()).rejects.toThrow(/nothing to build since sequence 1/i);
    await expect(p.build(true)).resolves.toMatchObject({ sequence: 2 });
  });

  it("refuses an output path that exists and is not a directory", async () => {
    const p = await publisher();
    await p.add();
    await writeFile(p.out, "precious", "utf8");

    await expect(p.build()).rejects.toThrow(/exists and is not a directory/i);

    // The operator's file survives: publishing must never silently destroy it.
    expect(await readFile(p.out, "utf8")).toBe("precious");
  });

  it("leaves the sequence unchanged when publishing fails", async () => {
    const p = await publisher();
    await p.add();
    const parent = path.dirname(p.out);
    await chmod(parent, 0o500);

    await expect(p.build()).rejects.toThrow();

    await chmod(parent, 0o700);
    expect((await readWorkspace(p.paths)).sequence).toBe(0);
    await expect(stat(p.out)).rejects.toThrow();
  });

  it("refuses an expiry outside its bounds", async () => {
    const p = await publisher();
    await p.add();

    await expect(buildDistribution(p.paths, { out: p.out, expiresIn: "9999d" }))
      .rejects.toThrow(/at most 365d/i);
  });
});

describe("publisher add", () => {
  it("refuses a coordinate that would resolve to different bytes", async () => {
    const p = await publisher();
    const root = path.dirname(p.paths.root);
    await p.add();
    const mutated = path.join(root, "mutated.json");
    await writeFile(mutated, JSON.stringify({ ...TEMPLATE, displayName: "Changed" }), "utf8");

    await expect(addPackage(p.paths, mutated, "1.0.0")).rejects.toThrow(/immutable/i);
  });

  it("is idempotent for identical bytes", async () => {
    const p = await publisher();
    await p.add();

    const again = await p.add();

    expect(again).toMatch(/^sha256:/);
    expect((await readWorkspace(p.paths)).packages).toHaveLength(1);
  });
});

describe("publisher lifecycle", () => {
  it("keeps pre-rotation packages verifiable after a publisher key rotation", async () => {
    const p = await publisher();
    await p.add();
    await p.build();
    // The state a client holds having accepted sequence 1 under the ORIGINAL key.
    const pinnedAtSequence1 = await readWorkspace(p.paths);

    await stageRotatePublisherKey(p.paths, "acme-publisher-2027-01");
    const result = await p.build();

    expect(result.sequence).toBe(2);
    const ws = await readWorkspace(p.paths);
    expect(ws.publisherKey.keyId).toBe("acme-publisher-2027-01");

    // THE DECISIVE ASSERTION. A client pinned at the old key walks the rotation chain and
    // must still verify the package that was published BEFORE the rotation. Without
    // re-signing, verifySignedPackage refuses it with wrong-key: the index announces the
    // successor, but the envelope still carries the retired key id.
    await expect(verifyAsPinnedClient(p, pinnedAtSequence1)).resolves.toBeDefined();
  });

  it("retains rotation history in every later index", async () => {
    const p = await publisher();
    await p.add();
    await p.build();
    await stageRotatePublisherKey(p.paths, "acme-publisher-2027-01");
    await p.build();
    await stageRotatePublisherKey(p.paths, "acme-publisher-2028-01");
    await p.build();

    const index = parseSignedTapIndex(await readFile(path.join(p.out, "index.json"), "utf8"));

    // A client that skipped sequence 2 must still walk key 1 -> 2 -> 3 from the latest index.
    expect(index.rotations).toHaveLength(2);
    expect(index.rotations.map((r) => r.effectiveSequence)).toEqual([2, 3]);
  });

  it("signs a tap-rotating index with the successor tap key", async () => {
    const p = await publisher();
    await p.add();
    await p.build();

    await stageRotateTapKey(p.paths, "community-tap-2027-01");
    await p.build();

    const index = parseSignedTapIndex(await readFile(path.join(p.out, "index.json"), "utf8"));
    expect(index.signature.keyId).toBe("community-tap-2027-01");
    expect(index.tapKeyRotation).toMatchObject({ effectiveSequence: 2 });
    const ws = await readWorkspace(p.paths);
    expect(ws.tapKey.keyId).toBe("community-tap-2027-01");
  });

  it("excludes a revoked package from the built index", async () => {
    const p = await publisher();
    const digest = await p.add();
    await p.build();

    await stageRevokePackage(p.paths, digest, "compromised build");
    const result = await p.build();

    expect(result.packageCount).toBe(0);
    const index = parseSignedTapIndex(await readFile(path.join(p.out, "index.json"), "utf8"));
    expect(index.packages).toHaveLength(0);
    expect(index.revocations).toHaveLength(1);
    expect(await readdir(path.join(p.out, "packages", "sha256"))).toHaveLength(0);
  });

  it("refuses revoking the active publisher key without a paired rotation", async () => {
    const p = await publisher();
    const ws = await readWorkspace(p.paths);

    await expect(stageRevokePublisherKey(p.paths, ws.publisherKey.keyId, "leaked"))
      .rejects.toThrow(/requires rotating to a successor/i);
  });

  it("refuses a revocation for a digest this workspace never published", async () => {
    const p = await publisher();

    await expect(stageRevokePackage(p.paths, `sha256:${"b".repeat(64)}`, "nope"))
      .rejects.toThrow(/no package in this workspace/i);
  });
});

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
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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
import { readWorkspace, writeWorkspace } from "../src/profile/templates/publish/workspace-store.js";
import { verifyBuiltDistribution } from "../src/profile/templates/publish/build-verify.js";
import type { PublisherWorkspace, WorkspacePackage } from "../src/profile/templates/publish/workspace-types.js";
import { parseSignedTapIndex } from "../src/profile/templates/signing/protocol.js";
import { generateEd25519Keypair } from "../src/profile/templates/signing/sign.js";
import { canonicalDigest } from "../src/profile/templates/signing/canonical.js";
import { readDistributionOnDisk } from "../src/profile/templates/publish/tree-read.js";
import { PUBLISHER_TEMPLATE, publisherTempRoots } from "./fixtures/publisher-workspace.js";

const roots = publisherTempRoots();
afterEach(roots.cleanup);


interface Publisher {
  paths: WorkspacePaths;
  out: string;
  keyFile: string;
  add: () => Promise<string>;
  addSecond: () => Promise<string>;
  build: (force?: boolean, refresh?: boolean) => Promise<{ sequence: number; packageCount: number }>;
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
      await writeFile(file, JSON.stringify(PUBLISHER_TEMPLATE), "utf8");
      const result = await addPackage(paths, file, "1.0.0");
      return result.payloadDigest;
    },
    addSecond: async () => {
      const second = {
        ...PUBLISHER_TEMPLATE,
        templateId: "postmortem",
        profile: { ...PUBLISHER_TEMPLATE.profile, profileId: "postmortem" },
      };
      const file = path.join(root, "postmortem.json");
      await writeFile(file, JSON.stringify(second), "utf8");
      const result = await addPackage(paths, file, "1.0.0");
      return result.payloadDigest;
    },
    build: async (force = false, refresh = false) =>
      buildDistribution(paths, { out, expiresIn: "30d", force, refresh }),
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

  // A no-change rebuild is refused; --force overrides it, and --refresh renews an expiring
  // index (same content, fresh lifetime) so a routine renewal never needs the blunt --force.
  it.each([
    { label: "--force", rebuild: (p: Publisher) => p.build(true) },
    { label: "--refresh", rebuild: (p: Publisher) => p.build(false, true) },
  ])("refuses a no-change rebuild but allows $label", async ({ rebuild }) => {
    const p = await publisher();
    await p.add();
    await p.build();

    await expect(p.build()).rejects.toThrow(/nothing to build since sequence 1/i);
    await expect(rebuild(p)).resolves.toMatchObject({ sequence: 2 });
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
    await writeFile(mutated, JSON.stringify({ ...PUBLISHER_TEMPLATE, displayName: "Changed" }), "utf8");

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

describe("publisher adversarial-audit regressions", () => {
  it("builds again after a package is added to a released workspace", async () => {
    const p = await publisher();
    await p.add();
    await p.build();
    // `add` records a package without staging an intent, so a `pending`-only dirty check
    // refused the core workflow: release, add another template, release again.
    await p.addSecond();

    await expect(p.build()).resolves.toMatchObject({ sequence: 2, packageCount: 2 });
  });

  it("verifies a snapshot whose index carries RETAINED rotation history", async () => {
    const p = await publisher();
    await p.add();
    await p.build();
    await stageRotatePublisherKey(p.paths, "acme-publisher-2027-01");
    await p.build();
    // Rotations are retained in every later index forever. Refusing them outright made
    // `publish verify` permanently unusable for any tap that had ever rotated a key.
    await p.addSecond();
    await p.build();

    await expect(verifySnapshot(p)).resolves.toBeUndefined();
  });

  it("refuses an output directory holding unrelated operator data", async () => {
    const p = await publisher();
    await p.add();
    await mkdir(p.out, { recursive: true });
    await writeFile(path.join(p.out, "index.html"), "<h1>my site</h1>", "utf8");

    await expect(p.build()).rejects.toThrow(/not a tree this workspace published/i);

    expect(await readFile(path.join(p.out, "index.html"), "utf8")).toContain("my site");
  });

  it("refuses a second staged rotation for the same role", async () => {
    const p = await publisher();
    await stageRotatePublisherKey(p.paths, "acme-publisher-2027-01");

    await expect(stageRotatePublisherKey(p.paths, "acme-publisher-2028-01"))
      .rejects.toThrow(/already staged/i);
  });

  it("refuses revoking the key a staged rotation would make active", async () => {
    const p = await publisher();
    await stageRotatePublisherKey(p.paths, "acme-publisher-2027-01");

    await expect(stageRevokePublisherKey(p.paths, "acme-publisher-2027-01", "oops"))
      .rejects.toThrow(/would make active/i);
  });

  it("never reissues a sequence that was already handed to a published tree", async () => {
    const p = await publisher();
    await p.add();
    const first = await p.build();
    // Simulate a crash after publishing but before committing.
    const ws = await readWorkspace(p.paths);
    await writeWorkspace(p.paths, {
      ...ws,
      reservedBuild: { ...ws.lastBuild!, sequence: 2, indexDigest: `sha256:${"c".repeat(64)}` },
    });
    await p.addSecond();

    // Re-issuing sequence 2 with different bytes would be a replay for any client that
    // fetched the published index, so the retry moves past it.
    await expect(p.build()).resolves.toMatchObject({ sequence: 3 });
    expect(first.sequence).toBe(1);
  });
});

describe("publisher second-audit regressions", () => {
  it("refuses an output tree it did not itself publish, even one that looks right", async () => {
    const p = await publisher();
    await p.add();
    await p.build();
    // A forged index that merely CLAIMS this tap is just bytes. Only a tree whose index
    // digests to what we recorded publishing may be replaced — everything else is data we
    // must not delete.
    await writeFile(path.join(p.out, "index.json"), JSON.stringify({ forged: true }), "utf8");
    await p.addSecond();

    await expect(p.build()).rejects.toThrow(/not a tree this workspace published/i);

    expect(await readFile(path.join(p.out, "index.json"), "utf8")).toContain("forged");
  });

  it("refuses to write a private key through a symlinked keys directory", async () => {
    const p = await publisher();
    const outside = await roots.create("key-escape");
    await rm(p.paths.keysDir, { recursive: true, force: true });
    await symlink(outside, p.paths.keysDir);

    await expect(stageRotatePublisherKey(p.paths, "acme-publisher-2027-01"))
      .rejects.toThrow(/escapes|confine|unsafe/i);

    // The point of the guard: no key material may land outside the workspace.
    expect((await readdir(outside)).filter((f) => f.endsWith(".key") || f.endsWith(".pub"))).toEqual([]);
  });

  it("never reuses a retired key id", async () => {
    const p = await publisher();
    await p.add();
    await p.build();
    const original = (await readWorkspace(p.paths)).publisherKey.keyId;
    await stageRotatePublisherKey(p.paths, "acme-publisher-2027-01");
    await p.build();

    // Consumers record every key id they have ever accepted, so re-announcing a retired one
    // yields a release every existing client rejects.
    await expect(stageRotatePublisherKey(p.paths, original))
      .rejects.toThrow(/already been used|never be reused/i);
  });

  it("refuses to record a package signed by a key the workspace does not announce", async () => {
    const p = await publisher();
    const ws = await readWorkspace(p.paths);
    // The announced public key no longer matches the private key on disk.
    const foreign = generateEd25519Keypair(ws.publisherKey.keyId);
    await writeWorkspace(p.paths, { ...ws, publisherKey: foreign.publicKey });

    await expect(p.add()).rejects.toThrow(/does not match the workspace's announced publisher key/i);
  });
});

describe("publisher third-audit regressions", () => {
  it("refuses to delete a directory that merely holds a COPY of our index", async () => {
    const p = await publisher();
    await p.add();
    await p.build();
    // The index is PUBLIC and copyable. Dropping a legitimate index beside somebody's files
    // must not make their directory look like ours and get it deleted.
    const victim = path.join(await roots.create("victim"), "site");
    await mkdir(path.join(victim, "packages"), { recursive: true });
    await writeFile(path.join(victim, "index.json"), await readFile(path.join(p.out, "index.json"), "utf8"), "utf8");
    await writeFile(path.join(victim, "packages", "do-not-delete.txt"), "PRECIOUS", "utf8");
    await p.addSecond();

    await expect(buildDistribution(p.paths, { out: victim, expiresIn: "30d" }))
      .rejects.toThrow(/not a tree this workspace published/i);

    expect(await readFile(path.join(victim, "packages", "do-not-delete.txt"), "utf8")).toBe("PRECIOUS");
  });

  it("recovers from a commit that never landed instead of deadlocking", async () => {
    const p = await publisher();
    await p.add();
    await p.build();
    // Crash after the swap, before the commit: the workspace still names the OLD index while
    // the NEW one is live. The retry must recognize the published tree as ours.
    const ws = await readWorkspace(p.paths);
    const published = JSON.parse(await readFile(path.join(p.out, "index.json"), "utf8")) as object;
    await writeWorkspace(p.paths, {
      ...ws,
      sequence: 0,
      lastBuild: undefined as never,
      reservedBuild: { ...ws.lastBuild!, indexDigest: canonicalDigest(published) },
    });

    await expect(p.build(true)).resolves.toMatchObject({ sequence: 2 });
  });

  it.each([
    { label: "publisher rotation", stage: async (p: Publisher) => stageRotatePublisherKey(p.paths, "acme-publisher-2027-01") },
    { label: "tap rotation", stage: async (p: Publisher) => stageRotateTapKey(p.paths, "community-tap-2027-01") },
    { label: "package revocation", stage: async (p: Publisher) => {
      const ws = await readWorkspace(p.paths);
      await stageRevokePackage(p.paths, ws.coordinates[Object.keys(ws.coordinates)[0]], "superseded");
    } },
  ])("refuses a no-change build after a $label", async ({ stage }) => {
    const p = await publisher();
    await p.add();
    await p.build();
    await stage(p);
    await expect(p.build()).resolves.toMatchObject({ sequence: 2 });

    // The recorded content identity must reflect the COMMITTED state (successor keys, new
    // revocations). If it recorded the pre-build keys, this third build would see a false
    // change and publish sequence 3.
    await expect(p.build()).rejects.toThrow(/nothing to build since sequence 2/i);
  });

  it("refuses a staged tree carrying a duplicate envelope in place of a package", async () => {
    const p = await publisher();
    await p.add();
    await p.addSecond();
    await p.build();
    // A name-and-count check would accept two copies of one valid envelope standing in for
    // another package. The exact-tree verifier derives filenames from the index's digests.
    const digestDir = path.join(p.out, "packages", "sha256");
    const [a, b] = (await readdir(digestDir)).sort();
    await writeFile(path.join(digestDir, b), await readFile(path.join(digestDir, a), "utf8"), "utf8");

    await expect(readDistributionOnDisk(p.out)).rejects.toThrow();
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

/**
 * Tests for the artifact store: validated canonical paths, the sidecar
 * manifest, content-hashing, confined atomic writes, and the handle-bound
 * no-follow-leaf reads (body + manifest). The security-critical cases are
 * the traversal/dotfile/separator path rejection, the symlinked-leaf
 * fail-closed, the symlinked-PARENT escape, and the swap-out/open/swap-back
 * race defeated by the {dev,ino} handle binding.
 */
import { describe, it, expect } from "vitest";
import path from "path";
import { readFile, symlink, writeFile, mkdir, rm, rename } from "fs/promises";
import { makeTempRoot } from "../fixtures/temp-root.js";
import { makeOutsideDir } from "../fixtures/outside-dir.js";
import { artifactPaths, hashArtifactBody, writeArtifactFiles, readArtifactManifest, readArtifactBody, parseManifest, ArtifactPathError } from "../../src/artifacts/store.js";

/** Assert both the body and manifest reads come back "unavailable" for the given paths. */
async function expectBothUnavailable(root: string, paths: ReturnType<typeof artifactPaths>) {
  expect((await readArtifactBody(root, paths, 1024)).kind).toBe("unavailable");
  expect((await readArtifactManifest(root, paths)).kind).toBe("unavailable");
}

/**
 * Shared plumbing for the swap-out/open/swap-back parent race: plants
 * `outsideContent` at the outside target, swaps `<slug>`'s parent to a
 * symlink pointing there, then swaps it BACK to the real in-root dir after
 * the open but before the {dev,ino} binding check runs. Returns the
 * resulting body read so callers can assert on `outsideContent` of any size.
 */
async function swapBackRace(prefix: string, outsideContent: string) {
  const root = await makeTempRoot(prefix);
  const outside = await makeOutsideDir();
  await mkdir(path.join(outside, "evil"), { recursive: true });
  await writeFile(path.join(outside, "evil", "result.json"), outsideContent);
  const paths = artifactPaths(root, "experiment-result", "probe", "result.json");
  await mkdir(paths.expectedDir, { recursive: true });
  await writeFile(paths.bytesPath, "INSIDE-bytes");
  const realDir = paths.expectedDir + ".real";
  await rename(paths.expectedDir, realDir);                    // swap OUT: <slug> → symlink to outside
  await symlink(path.join(outside, "evil"), paths.expectedDir);
  const swapBack = async () => {                               // fires AFTER open, BEFORE the binding check
    await rm(paths.expectedDir);
    await rename(realDir, paths.expectedDir);                  // swap BACK: canonical path is in-tree again
  };
  return readArtifactBody(root, paths, 1024, { afterOpenForTest: swapBack });
}

describe("artifact store", () => {
  it("writes bytes + manifest at the canonical confined path and reads the manifest back", async () => {
    const root = await makeTempRoot("artifact-store");
    const body = `{"accuracy":0.9}`;
    const paths = artifactPaths(root, "experiment-result", "probe", "result.json");
    expect(paths.bytesPath).toBe(path.join(root, "artifacts/experiment-result/probe/result.json"));
    const sha256 = hashArtifactBody(body);
    await writeArtifactFiles(root, paths, body, { artifactType: "experiment-result", slug: "probe", sha256, bytes: Buffer.byteLength(body), contentKind: "json", writtenAt: "2026-07-02T00:00:00.000Z" });
    expect(await readFile(paths.bytesPath, "utf8")).toBe(body);
    const read = await readArtifactManifest(root, paths);
    expect(read.kind === "ok" && read.manifest.sha256).toBe(sha256);
  });
  it("rejects a traversal / dotfile / separator slug or type at the path boundary", () => {
    for (const bad of ["../x", ".x", "a/b", "A", "x y"]) {
      expect(() => artifactPaths("/tmp/x", "experiment-result", bad, "result.json")).toThrow(ArtifactPathError);
      expect(() => artifactPaths("/tmp/x", bad, "probe", "result.json")).toThrow(ArtifactPathError);
    }
  });
  it("fails closed on a symlinked-leaf body or manifest (never follows it)", async () => {
    const root = await makeTempRoot("artifact-symleaf");
    const outside = await makeOutsideDir();
    await writeFile(path.join(outside, "leak.md"), "secret");
    const paths = artifactPaths(root, "experiment-result", "probe", "result.json");
    await mkdir(paths.expectedDir, { recursive: true });
    await symlink(path.join(outside, "leak.md"), paths.bytesPath);      // symlinked body leaf
    await symlink(path.join(outside, "leak.md"), paths.manifestPath);   // symlinked manifest leaf
    await expectBothUnavailable(root, paths);
  });
  it("fails closed on a symlinked PARENT escaping the project (root-anchored confinement)", async () => {
    const root = await makeTempRoot("artifact-symparent");
    const outside = await makeOutsideDir();
    await mkdir(path.join(outside, "evil"), { recursive: true });
    await writeFile(path.join(outside, "evil", "result.json"), `{"accuracy":0.1}`);
    await writeFile(path.join(outside, "evil", "result.json.manifest.json"), "{}");
    const paths = artifactPaths(root, "experiment-result", "probe", "result.json");
    await mkdir(path.dirname(paths.expectedDir), { recursive: true });
    await symlink(path.join(outside, "evil"), paths.expectedDir); // <slug> dir is a symlink OUT of tree
    await expectBothUnavailable(root, paths);
  });
  it("defeats a swap-out/open/swap-back parent race via the {dev,ino} handle binding", async () => {
    const out = await swapBackRace("artifact-swapback", "OUTSIDE-bytes");
    expect(out.kind).toBe("unavailable");                        // handle bound to OUTSIDE inode ≠ canonical in-root inode
  });
  it("defeats the same race when the outside file is OVERSIZE (never leaks its size as oversize)", async () => {
    const out = await swapBackRace("artifact-swapback-oversize", "y".repeat(2048)); // > cap
    expect(out.kind).toBe("unavailable");                        // never "oversize" — no outside byte count leaks
  });
  it("reports absent (not unavailable) when neither file has been written yet", async () => {
    const root = await makeTempRoot("artifact-absent");
    const paths = artifactPaths(root, "experiment-result", "probe", "result.json");
    expect((await readArtifactBody(root, paths, 1024)).kind).toBe("absent");
    expect((await readArtifactManifest(root, paths)).kind).toBe("absent");
  });
  it("returns a distinguishable oversize outcome (not unavailable) for a legitimate in-root body over the byte cap", async () => {
    const root = await makeTempRoot("artifact-oversize");
    const paths = artifactPaths(root, "experiment-result", "probe", "result.json");
    await mkdir(paths.expectedDir, { recursive: true });
    await writeFile(paths.bytesPath, "x".repeat(2048));
    expect(await readArtifactBody(root, paths, 1024)).toEqual({ kind: "oversize", actualBytes: 2048 });
  });
  it("still rejects an oversize MANIFEST as unavailable (unchanged — manifests never get the oversize outcome)", async () => {
    const root = await makeTempRoot("artifact-oversize-manifest");
    const paths = artifactPaths(root, "experiment-result", "probe", "result.json");
    await mkdir(paths.expectedDir, { recursive: true });
    await writeFile(paths.manifestPath, "x".repeat(2048));
    expect((await readArtifactManifest(root, paths, 1024)).kind).toBe("unavailable");
  });
  it("[P3.1] never classifies an oversize body reached through a symlinked PARENT as oversize (fails closed as unavailable)", async () => {
    // If `oversize` were classified BEFORE the post-open confinement check, a
    // parent-dir swap to an out-of-root symlink would let this outside file's
    // size leak out as `actualBytes` and (at resolve level) trigger a FALSE
    // artifact-bytes-tampered verdict. Confinement must fail first.
    const root = await makeTempRoot("artifact-oversize-symparent");
    const outside = await makeOutsideDir();
    await mkdir(path.join(outside, "evil"), { recursive: true });
    await writeFile(path.join(outside, "evil", "result.json"), "y".repeat(2048)); // > cap
    const paths = artifactPaths(root, "experiment-result", "probe", "result.json");
    await mkdir(path.dirname(paths.expectedDir), { recursive: true });
    await symlink(path.join(outside, "evil"), paths.expectedDir); // <slug> dir is a symlink OUT of tree
    expect((await readArtifactBody(root, paths, 1024)).kind).toBe("unavailable");
  });
  it("classifies invalid JSON and wrong-shape JSON manifests as malformed, not unavailable", async () => {
    const root = await makeTempRoot("artifact-malformed");
    const paths = artifactPaths(root, "experiment-result", "probe", "result.json");
    await mkdir(paths.expectedDir, { recursive: true });
    await writeFile(paths.manifestPath, "not json");
    expect((await readArtifactManifest(root, paths)).kind).toBe("malformed");
    await writeFile(paths.manifestPath, JSON.stringify({ artifactType: "experiment-result" }));
    expect((await readArtifactManifest(root, paths)).kind).toBe("malformed");
  });
});

describe("parseManifest", () => {
  const valid = {
    artifactType: "experiment-result", slug: "probe", sha256: "a".repeat(64),
    bytes: 10, contentKind: "json" as const, writtenAt: "2026-07-02T00:00:00.000Z",
  };

  it("accepts a well-formed manifest", () => {
    expect(parseManifest(valid)).toEqual(valid);
  });

  it.each([
    ["a non-object", "not an object"],
    ["a missing artifactType", { ...valid, artifactType: "" }],
    ["a missing slug", { ...valid, slug: undefined }],
    ["a non-string writtenAt", { ...valid, writtenAt: 123 }],
    ["a non-hex sha256", { ...valid, sha256: "not-hex" }],
    ["a fractional bytes count", { ...valid, bytes: 1.5 }],
    ["a negative bytes count", { ...valid, bytes: -1 }],
    ["an unrecognized contentKind", { ...valid, contentKind: "xml" }],
  ])("rejects %s", (_label, raw) => {
    expect(parseManifest(raw)).toBeNull();
  });
});

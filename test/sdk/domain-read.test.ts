/**
 * Public domain-read contract used by external process coordinators. These
 * witnesses exercise real profile state and filesystem boundaries through the
 * package entry point, without granting mutation authority.
 */
import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as sdk from "../../src/index.js";
import { makeResearchLikeRoot } from "../fixtures/artifact-root.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

it("observes the default profile without creating project files", async () => {
  root = await mkdtemp(path.join(tmpdir(), "sdk-domain-read-"));
  expect(await sdk.activeProfileDigest(root)).toMatch(/^[a-f0-9]{64}$/);
  expect(await sdk.loadNonDefaultProfile(root)).toBeUndefined();
  expect(await readdir(root)).toEqual([]);
});

it("binds the selected non-default profile and refuses malformed replacements", async () => {
  root = await makeResearchLikeRoot("sdk-domain-profile");
  const loaded = await sdk.loadNonDefaultProfile(root);
  expect(loaded?.profile.entities.note.directory).toBe("wiki/notes");
  expect(await sdk.activeProfileDigest(root)).toBe(loaded?.digest);
  await writeFile(path.join(root, ".llmwiki/profile.json"), "{invalid");
  await expect(sdk.activeProfileDigest(root)).rejects.toThrow();
  await expect(sdk.loadNonDefaultProfile(root)).rejects.toThrow();
});

it("returns exact binary bytes, bounded oversize, and genuine leaf absence", async () => {
  root = await mkdtemp(path.join(tmpdir(), "sdk-domain-read-"));
  const leaf = path.join(root, "record.md");
  await writeFile(leaf, Buffer.from([0xff, 0x00, 0x80]));
  expect(await sdk.readConfinedCappedBuffer(root, leaf, root, 3))
    .toEqual({ kind: "ok", body: Buffer.from([0xff, 0x00, 0x80]) });
  expect(await sdk.readConfinedCappedBuffer(root, leaf, root, 2))
    .toEqual({ kind: "oversize", actualBytes: 3 });
  expect(await sdk.readConfinedCappedBuffer(root, path.join(root, "missing"), root, 3))
    .toEqual({ kind: "absent" });
});

it("refuses out-of-root or mismatched selectors and invalid budgets", async () => {
  root = await mkdtemp(path.join(tmpdir(), "sdk-domain-read-"));
  const leaf = path.join(root, "record.md");
  await writeFile(leaf, "data");
  for (const limit of [-1, NaN, Infinity, 0.5]) {
    expect(await sdk.readConfinedCappedBuffer(root, leaf, root, limit)).toEqual({ kind: "unavailable" });
  }
  expect(await sdk.readConfinedCappedBuffer(root, leaf, path.dirname(root), 10)).toEqual({ kind: "unavailable" });
  expect(await sdk.readConfinedCappedBuffer(root, path.join(path.dirname(root), "missing"), path.dirname(root), 10))
    .toEqual({ kind: "unavailable" });
});

it("refuses symlinked leaves and parents even for a missing leaf", async () => {
  root = await mkdtemp(path.join(tmpdir(), "sdk-domain-read-"));
  const real = path.join(root, "real"), alias = path.join(root, "alias");
  await mkdir(real);
  await writeFile(path.join(real, "record.md"), "data");
  await symlink(real, alias);
  await symlink(path.join(real, "record.md"), path.join(real, "link.md"));
  for (const name of ["record.md", "missing.md"]) {
    expect(await sdk.readConfinedCappedBuffer(root, path.join(alias, name), alias, 10)).toEqual({ kind: "unavailable" });
  }
  expect(await sdk.readConfinedCappedBuffer(root, path.join(real, "link.md"), real, 10)).toEqual({ kind: "unavailable" });
});

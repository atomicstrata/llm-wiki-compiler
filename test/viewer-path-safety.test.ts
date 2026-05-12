/**
 * Tests for the viewer path-safety primitives.
 *
 * Exercises the full chain a route handler is expected to follow:
 * `decodeURIComponent` → `assertSafeSlug` → `resolveUnderRoot`
 * → `assertViewerSubtree`. Each layer has a dedicated test block so the
 * failure mode reported on regression matches the contract that broke.
 */

import { describe, it, expect } from "vitest";
import { mkdir, symlink, writeFile, realpath } from "fs/promises";
import path from "path";
import os from "os";
import {
  assertSafeSlug,
  assertViewerSubtree,
  PathSafetyError,
  resolveUnderRoot,
} from "../src/viewer/path-safety.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { makeOutsideDir } from "./fixtures/outside-dir.js";

describe("assertSafeSlug", () => {
  it("accepts plain ASCII slugs", () => {
    expect(() => assertSafeSlug("attention")).not.toThrow();
  });

  it("accepts Unicode slugs", () => {
    expect(() => assertSafeSlug("注意力")).not.toThrow();
    expect(() => assertSafeSlug("café")).not.toThrow();
    expect(() => assertSafeSlug("naïve-implementation")).not.toThrow();
  });

  it("rejects empty, dot, and dot-dot slugs", () => {
    expect(() => assertSafeSlug("")).toThrow(PathSafetyError);
    expect(() => assertSafeSlug(".")).toThrow(PathSafetyError);
    expect(() => assertSafeSlug("..")).toThrow(PathSafetyError);
  });

  it("rejects forward and backslash separators in the decoded slug", () => {
    expect(() => assertSafeSlug("a/b")).toThrow(PathSafetyError);
    expect(() => assertSafeSlug("a\\b")).toThrow(PathSafetyError);
    expect(() => assertSafeSlug("../escape")).toThrow(PathSafetyError);
  });

  it("rejects NUL bytes", () => {
    expect(() => assertSafeSlug("foo\0bar")).toThrow(PathSafetyError);
  });

  it("rejects encoded traversal after one decode pass", () => {
    const decoded = decodeURIComponent("%2e%2e%2fescape");
    expect(() => assertSafeSlug(decoded)).toThrow(PathSafetyError);
  });
});

describe("resolveUnderRoot", () => {
  it("resolves a clean nested segment under the project root", async () => {
    const root = await makeTempRoot("path-safety-clean");
    const real = await realpath(root);
    const resolved = await resolveUnderRoot(root, "wiki", "concepts");
    expect(resolved).toBe(path.join(real, "wiki", "concepts"));
  });

  it("rejects absolute segments", async () => {
    const root = await makeTempRoot("path-safety-abs");
    await expect(resolveUnderRoot(root, "/etc/passwd")).rejects.toThrow(PathSafetyError);
  });

  it("rejects symlinks that escape the project root", async () => {
    const root = await makeTempRoot("path-safety-symlink");
    const outsideRoot = await makeOutsideDir();
    await writeFile(path.join(outsideRoot, "secret.md"), "secret");
    await symlink(outsideRoot, path.join(root, "wiki", "concepts", "evil"));
    await expect(
      resolveUnderRoot(root, "wiki", "concepts", "evil", "secret.md"),
    ).rejects.toThrow(PathSafetyError);
  });
});

describe("assertViewerSubtree", () => {
  it("accepts paths under wiki/", async () => {
    const root = await realpath(await makeTempRoot("subtree-wiki"));
    await expect(
      assertViewerSubtree(root, path.join(root, "wiki", "concepts", "x.md")),
    ).resolves.toBeUndefined();
  });

  it("accepts paths under sources/", async () => {
    const root = await realpath(await makeTempRoot("subtree-sources"));
    await expect(
      assertViewerSubtree(root, path.join(root, "sources", "paper.md")),
    ).resolves.toBeUndefined();
  });

  it("accepts exactly .llmwiki/last-lint.json", async () => {
    const root = await realpath(await makeTempRoot("subtree-lint"));
    await expect(
      assertViewerSubtree(root, path.join(root, ".llmwiki", "last-lint.json")),
    ).resolves.toBeUndefined();
  });

  it("rejects other paths under .llmwiki/", async () => {
    const root = await realpath(await makeTempRoot("subtree-llmwiki-other"));
    await expect(
      assertViewerSubtree(root, path.join(root, ".llmwiki", "state.json")),
    ).rejects.toThrow(PathSafetyError);
  });

  it("rejects .git/, node_modules/, and arbitrary top-level files", async () => {
    const root = await realpath(await makeTempRoot("subtree-other"));
    await expect(assertViewerSubtree(root, path.join(root, ".git", "HEAD"))).rejects.toThrow(
      PathSafetyError,
    );
    await expect(
      assertViewerSubtree(root, path.join(root, "node_modules", "pkg")),
    ).rejects.toThrow(PathSafetyError);
    await expect(assertViewerSubtree(root, path.join(root, "README.md"))).rejects.toThrow(
      PathSafetyError,
    );
  });

  it("rejects paths outside the project root", async () => {
    const root = await realpath(await makeTempRoot("subtree-outside"));
    await expect(assertViewerSubtree(root, "/etc/passwd")).rejects.toThrow(PathSafetyError);
  });

  it("accepts a valid file even when the project root is itself a symlink", async () => {
    const realRoot = await realpath(await makeTempRoot("subtree-symlink-root-real"));
    const linkParent = path.join(
      os.tmpdir(),
      `subtree-symlink-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    // Symlink the project root to a new path; the test passes the symlinked
    // path to assertViewerSubtree to prove canonicalization happens inside.
    await symlink(realRoot, linkParent);
    // Use the non-canonical (symlinked) root — assertViewerSubtree must
    // canonicalize internally so legitimate files under realRoot aren't
    // false-rejected just because the caller passed the symlink path.
    const resolvedFile = path.join(realRoot, "wiki", "concepts", "x.md");
    await expect(assertViewerSubtree(linkParent, resolvedFile)).resolves.toBeUndefined();
  });
});

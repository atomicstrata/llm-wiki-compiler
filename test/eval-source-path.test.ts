/**
 * Path-confinement tests for the eval harness's source-file resolver.
 *
 * Verifies that `resolveSourceFile` rejects parent traversal, nested
 * traversal, and symlinks pointing outside sources/, while allowing
 * legitimate relative paths.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "fs/promises";
import os from "os";
import path from "path";
import { resolveSourceFile } from "../src/eval/source-path.js";

describe("resolveSourceFile — path confinement", () => {
  let sourcesDir: string;
  let secretDir: string;

  beforeEach(async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "eval-source-path-"));
    sourcesDir = path.join(base, "sources");
    secretDir = await mkdtemp(path.join(os.tmpdir(), "eval-secret-"));
    await mkdir(sourcesDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(path.dirname(sourcesDir), { recursive: true, force: true });
    await rm(secretDir, { recursive: true, force: true });
  });

  it("returns the canonical path for a valid existing file", async () => {
    await writeFile(path.join(sourcesDir, "paper.md"), "content", "utf-8");
    const result = await resolveSourceFile(sourcesDir, "paper.md");
    expect(result).not.toBeNull();
    expect(result).toContain("paper.md");
  });

  it("returns null for a safe path that does not exist", async () => {
    const result = await resolveSourceFile(sourcesDir, "missing.md");
    expect(result).toBeNull();
  });

  it("rejects single-level parent traversal (../package.json)", async () => {
    await writeFile(path.join(path.dirname(sourcesDir), "package.json"), "{}", "utf-8");
    const result = await resolveSourceFile(sourcesDir, "../package.json");
    expect(result).toBeNull();
  });

  it("rejects nested traversal (nested/../../escape.md)", async () => {
    await writeFile(path.join(secretDir, "escape.md"), "leaked", "utf-8");
    const result = await resolveSourceFile(sourcesDir, "nested/../../escape.md");
    expect(result).toBeNull();
  });

  it("rejects a symlink inside sources/ pointing outside the source tree", async () => {
    const target = path.join(secretDir, "real.md");
    await writeFile(target, "leaked", "utf-8");
    await symlink(target, path.join(sourcesDir, "link.md"));
    const result = await resolveSourceFile(sourcesDir, "link.md");
    expect(result).toBeNull();
  });

  it("rejects absolute paths", async () => {
    const result = await resolveSourceFile(sourcesDir, "/etc/passwd");
    expect(result).toBeNull();
  });

  it("rejects empty string", async () => {
    const result = await resolveSourceFile(sourcesDir, "");
    expect(result).toBeNull();
  });

  it("allows a legitimate nested path inside sources/", async () => {
    await mkdir(path.join(sourcesDir, "sub"), { recursive: true });
    await writeFile(path.join(sourcesDir, "sub", "deep.md"), "ok", "utf-8");
    const result = await resolveSourceFile(sourcesDir, "sub/deep.md");
    expect(result).not.toBeNull();
    expect(result).toContain("deep.md");
  });
});

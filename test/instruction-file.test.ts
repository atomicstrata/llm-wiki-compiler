/**
 * Operator instruction-file boundary tests. Real filesystem reads pin the
 * bounded UTF-8 contract without adding untrusted-project confinement policy.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readInstructions } from "../src/cli/instructions.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "instruction-file-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("explicit instruction reads", () => {
  it("allows an explicit symlink to the operator's UTF-8 file", async () => {
    const file = path.join(root, "policy.md");
    await writeFile(file, "Use 日本語.\n");
    await symlink(file, path.join(root, "alias.md"));
    expect(await readInstructions(path.join(root, "alias.md"))).toBe("Use 日本語.\n");
  });

  it("accepts exactly 64 KiB without truncating", async () => {
    const file = path.join(root, "policy.md");
    const text = "a".repeat(65_536);
    await writeFile(file, text);
    expect(await readInstructions(file)).toBe(text);
  });

  it("rejects invalid UTF-8 rather than sending replacement characters", async () => {
    const file = path.join(root, "policy.md");
    await writeFile(file, Buffer.from([0xff]));
    await expect(readInstructions(file)).rejects.toThrow(/instructions/);
  });

  it("rejects a directory", async () => {
    await expect(readInstructions(root)).rejects.toThrow(/instructions/);
  });

  it("preserves an empty file and treats omission as no file", async () => {
    const file = path.join(root, "policy.md");
    await writeFile(file, "");
    expect(await readInstructions(file)).toBe("");
    expect(await readInstructions(undefined)).toBeUndefined();
  });
});

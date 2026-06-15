// test/path-confine-confine-under-root.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, symlink } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { confineUnderRoot } from "../src/utils/path-confine.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("confineUnderRoot", () => {
  it("accepts an inside path and a fresh non-existent default (mustExist:false)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cur-"));
    const out = await confineUnderRoot("dist/exports/okf", dir, { mustExist: false });
    expect(out).toBe(path.join(await import("fs/promises").then((m) => m.realpath(dir)), "dist/exports/okf"));
  });
  it("rejects .. traversal and an absolute path outside root", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cur2-"));
    await expect(confineUnderRoot("../escape", dir, { mustExist: false })).rejects.toThrow(/escape/i);
    await expect(confineUnderRoot("/etc", dir, { mustExist: false })).rejects.toThrow(/escape/i);
  });
  it("rejects a missing dir when mustExist, accepts an existing one", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cur3-"));
    await mkdir(path.join(dir, "bundle"));
    expect(await confineUnderRoot("bundle", dir, { mustExist: true })).toContain("bundle");
    await expect(confineUnderRoot("nope", dir, { mustExist: true })).rejects.toThrow();
  });
  it("rejects an existing target that is a symlink escape (mustExist:false)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cur4-"));
    const outside = await mkdtemp(path.join(tmpdir(), "cur4-out-"));
    await symlink(outside, path.join(dir, "link"));
    await expect(confineUnderRoot("link", dir, { mustExist: false })).rejects.toThrow(/escape/i);
    await rm(outside, { recursive: true, force: true });
  });
  it("rejects a FRESH child under a symlinked parent that escapes (nearest-existing-ancestor walk)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cur5-"));
    const outside = await mkdtemp(path.join(tmpdir(), "cur5-out-"));
    await symlink(outside, path.join(dir, "link")); // link → outside; "link/fresh/out" doesn't exist
    await expect(confineUnderRoot("link/fresh/out", dir, { mustExist: false })).rejects.toThrow(/escape/i);
    await rm(outside, { recursive: true, force: true });
  });
});

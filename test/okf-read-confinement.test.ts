import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, symlink, realpath } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { confinedInside } from "../src/import/okf-read.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("confinedInside (direct confinement guard)", () => {
  it("returns null when an entry's realpath escapes the bundle via symlink", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-conf-"));
    await mkdir(path.join(dir, "bundle"), { recursive: true });
    const realRoot = await realpath(path.join(dir, "bundle"));
    const outside = path.join(dir, "secret.md");
    await writeFile(outside, "x\n");
    await symlink(outside, path.join(realRoot, "escape.md"));
    expect(await confinedInside(realRoot, "escape.md")).toBeNull();
  });
  it("returns the real path for an in-bundle regular file", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-conf2-"));
    const realRoot = await realpath(dir);
    await writeFile(path.join(realRoot, "a.md"), "x\n");
    expect(await confinedInside(realRoot, "a.md")).toBe(path.join(realRoot, "a.md"));
  });
});

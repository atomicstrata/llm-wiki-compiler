import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deleteSource } from "../../src/sources/store.js";
import { PathSafetyError } from "../../src/viewer/path-safety.js";

describe("deleteSource", () => {
  it("true when removed, false when absent, throws on unsafe id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "src-del-"));
    await mkdir(path.join(root, "sources"), { recursive: true });
    await writeFile(path.join(root, "sources/a.md"), "---\ntitle: A\n---\nbody", "utf-8");

    expect(await deleteSource(root, "a.md")).toBe(true);
    expect(existsSync(path.join(root, "sources/a.md"))).toBe(false);
    expect(await deleteSource(root, "a.md")).toBe(false); // already gone
    await expect(deleteSource(root, "../etc/passwd.md")).rejects.toBeInstanceOf(PathSafetyError);
  });
});

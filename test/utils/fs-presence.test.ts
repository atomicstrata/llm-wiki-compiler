/**
 * @file test/utils/fs-presence.test.ts
 * @description The shared presence primitive keeps "not there" distinct from "could
 * not tell". Collapsing the two is the shape behind a whole defect class: callers that
 * treat absence as permissive would silently relax a safety state on a permission flip
 * or I/O fault. Absence must be PROVED (ENOENT); every other fault is `unavailable`.
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { lstatLeaf, readDirectoryNames } from "../../src/utils/fs-presence.js";

describe("filesystem presence classification", () => {
  const root = useTempRoot();

  it("proves absence only on ENOENT and reports every other fault as unavailable", async () => {
    const blocked = path.join(root.dir, "blocked");
    await mkdir(blocked, { recursive: true });
    const leaf = path.join(blocked, "leaf.json");
    await writeFile(leaf, "{}");
    expect((await lstatLeaf(leaf)).kind).toBe("present");
    expect((await lstatLeaf(path.join(blocked, "missing.json"))).kind).toBe("absent");
    await chmod(blocked, 0o000);
    try {
      expect((await lstatLeaf(leaf)).kind).toBe("unavailable");
      expect((await readDirectoryNames(blocked)).kind).toBe("unavailable");
    } finally {
      await chmod(blocked, 0o700);
    }
  });

  it("distinguishes an absent directory from an unreadable one", async () => {
    expect((await readDirectoryNames(path.join(root.dir, "nope"))).kind).toBe("absent");
    const present = await readDirectoryNames(root.dir);
    expect(present.kind).toBe("entries");
  });
});

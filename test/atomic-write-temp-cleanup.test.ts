/**
 * @file test/atomic-write-temp-cleanup.test.ts
 * @description FIX 1 — atomicWrite must not leak an orphan temp on a failed write.
 *
 * The random-named temp is opened with O_EXCL, then content is written and the
 * handle renamed onto the target. If `rename` (or the write) throws — e.g. the
 * target is a DIRECTORY (EISDIR) — the random temp would otherwise be left
 * behind forever. An orphan `*.tmp` in an OKF export dir makes the next
 * re-export throw because the empty-dir gate treats it as content. The fix
 * unlinks the temp (best-effort) on any failure after it is opened.
 */

import { describe, it, expect } from "vitest";
import { mkdir, readdir, readFile } from "fs/promises";
import path from "path";
import { atomicWrite } from "../src/utils/markdown.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";

const ctx = useConfinementRoots("temp-cleanup");

describe("atomicWrite temp-file cleanup on failure", () => {
  it("throws AND leaves no *.tmp orphan when the target is a directory", async () => {
    const target = path.join(ctx.root, "page.md");
    await mkdir(target); // make the rename target a directory → rename throws EISDIR

    await expect(atomicWrite(target, "body")).rejects.toThrow();

    const temps = (await readdir(ctx.root)).filter((f) => f.endsWith(".tmp"));
    expect(temps).toHaveLength(0);
  });

  it("a normal write still succeeds and leaves no temp", async () => {
    const target = path.join(ctx.root, "ok.md");
    await atomicWrite(target, "hello");
    expect(await readFile(target, "utf-8")).toBe("hello");
    expect((await readdir(ctx.root)).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });
});

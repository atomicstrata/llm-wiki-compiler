/**
 * @file test/storage/disk-local-reads-root-once.test.ts
 * @description A `diskLocalReads` binding looks its project root up once, not
 * once per confined read, and does not remember a root that failed to
 * resolve: a project created after the binding is read on the next ask.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { diskLocalReads } from "../../src/storage/disk-local-reads.js";

const roots: string[] = [];

/** A scratch directory removed after the test. */
function scratch(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "llmwiki-root-once-"));
  roots.push(dir);
  return dir;
}

/** Write `wiki/concepts/<slug>.md` under `root`. */
function writePage(root: string, slug: string): void {
  mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
  writeFileSync(path.join(root, "wiki", "concepts", `${slug}.md`), `# ${slug}\n`);
}

/** A project with pages a, b and c, and how many times `run` resolves its root. */
async function rootLookupsDuring(run: (reads: ReturnType<typeof diskLocalReads>) => Promise<void>): Promise<number> {
  const root = scratch();
  for (const slug of ["a", "b", "c"]) writePage(root, slug);
  const reads = diskLocalReads(root);
  const realpath = spyOn(fs, "realpathSync");
  try {
    await run(reads);
    return realpath.mock.calls.filter(([target]: unknown[]) => String(target) === root).length;
  } finally {
    realpath.mockRestore();
  }
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("diskLocalReads root lookup", () => {
  it("resolves the root once across many confined reads", async () => {
    const lookups = await rootLookupsDuring(async (reads) => {
      for (const slug of ["a", "b", "c"]) expect(await reads.readConfinedPage("wiki/concepts", slug)).toEqual({ content: `# ${slug}\n` });
      expect(await reads.readConfinedFile("wiki/concepts/a.md")).toEqual({ content: "# a\n" });
    });
    expect(lookups).toBe(1);
  });

  it("resolves the root once when the first reads run at the same time", async () => {
    const lookups = await rootLookupsDuring(async (reads) => {
      await Promise.all(["a", "b", "c"].map((slug) => reads.readConfinedPage("wiki/concepts", slug)));
    });
    expect(lookups).toBe(1);
  });

  it("looks a root that did not resolve up again on the next read", async () => {
    const root = path.join(scratch(), "later");
    const reads = diskLocalReads(root);
    expect(await reads.readConfinedPage("wiki/concepts", "a")).toEqual({ dropped: "no-root" });
    writePage(root, "a");
    expect(await reads.readConfinedPage("wiki/concepts", "a")).toEqual({ content: "# a\n" });
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { checkBrokenCitations } from "../src/linter/rules.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const CITING_BODY = "\n\nClaim. ^[missing.md:1-2]\n";

describe("checkBrokenCitations: imported-page exemption", () => {
  it("exempts imported pages but still flags non-imported pages with the same dangling citation", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-lint-"));
    await mkdir(path.join(dir, "wiki/concepts"), { recursive: true });
    await mkdir(path.join(dir, "sources"), { recursive: true });
    await writeFile(path.join(dir, "wiki/concepts/imported.md"),
      "---\ntitle: Imported\nprovenanceState: imported\n---" + CITING_BODY);
    await writeFile(path.join(dir, "wiki/concepts/local.md"),
      "---\ntitle: Local\n---" + CITING_BODY);
    const results = await checkBrokenCitations(dir);
    const broken = results.filter((r) => r.rule === "broken-citation");
    expect(broken.every((r) => !r.file.includes("imported.md"))).toBe(true);
    expect(broken.some((r) => r.file.includes("local.md"))).toBe(true);
  });
});

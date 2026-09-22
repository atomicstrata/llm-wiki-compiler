/**
 * @file test/lint-fix-preview-cli.test.ts
 * @description `llmwiki lint --fix-preview` through the REAL binary, on a
 * PROFILE-shaped wiki — the two conditions under which §4.6's fix preview did
 * not exist.
 *
 * TWO DEFECTS, ONE CONTROL. The fix-plan module was correct and UNREACHABLE —
 * nothing imported it, so its own green unit tests proved a function nobody
 * could run. And the page walker it (and the whole crosslink rule family)
 * shares was hardcoded to the generic `concepts/`+`queries/` directories, so on
 * a profile project (research-concepts, methods, …) it saw ZERO pages and
 * reported a clean wiki. This drives `dist/cli.js` on profile-named
 * directories, so it fails if either regresses.
 *
 * §4.6's clauses asserted directly: the deterministic fix renders as the exact
 * edit; the ambiguous case is a recommendation, not a guess; and nothing — not
 * one byte — is written.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fix-preview-cli-"));
  await mkdir(path.join(root, ".llmwiki"));
  await writeFile(path.join(root, ".llmwiki", "profile.json"), JSON.stringify({
    schemaVersion: 1, profileId: "research",
    entities: {
      ideas: { directory: "wiki/research-concepts" },
      methods: { directory: "wiki/methods" },
      papers: { directory: "wiki/research/papers" },
    },
  }));
  await mkdir(path.join(root, "wiki", "research-concepts"), { recursive: true });
  await mkdir(path.join(root, "wiki", "methods"), { recursive: true });
  // The fixable shape: the page's FILENAME differs from its TITLE.
  await writeFile(path.join(root, "wiki", "methods", "sdpa.md"),
    '---\ntitle: "Scaled Dot-Product Attention"\nstage: "designed"\n---\nBody.\n');
  await writeFile(path.join(root, "wiki", "research-concepts", "linker.md"),
    '---\ntitle: "Linker"\nstage: "proposed"\n---\n'
    + "Uses [[Scaled Dot-Product Attention]].\nAnd [[Totally Unknown Concept]].\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("lint --fix-preview through the real binary", () => {
  it("previews the exact edit and the recommendation on a profile wiki", async () => {
    const result = await runCLI(["lint", "--fix-preview"], root);
    expectCLIExit(result, 0);
    // The deterministic fix, as the concrete edit it would make:
    expect(result.stdout).toContain("- [[Scaled Dot-Product Attention]]");
    expect(result.stdout).toContain("+ [[sdpa|Scaled Dot-Product Attention]]");
    // The unfixable link, as a recommendation with its reason:
    expect(result.stdout).toContain("[[Totally Unknown Concept]] cannot be repaired automatically");
    expect(result.stdout).toContain("Nothing was written.");
  }, 30_000);

  it("checks links in NESTED profile directories too", async () => {
    // A profile may declare wiki/research/papers; the one-level walk silently
    // returned no pages for it and this preview reported a clean wiki.
    await mkdir(path.join(root, "wiki", "research", "papers"), { recursive: true });
    await writeFile(path.join(root, "wiki", "research", "papers", "nested.md"),
      '---\ntitle: "Nested"\n---\nCites [[Totally Unknown Concept]] too.\n');
    const result = await runCLI(["lint", "--fix-preview"], root);
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("2 recommendation(s)");
  }, 30_000);

  it("writes not one byte", async () => {
    const before = await readFile(path.join(root, "wiki", "research-concepts", "linker.md"), "utf8");
    await runCLI(["lint", "--fix-preview"], root);
    const after = await readFile(path.join(root, "wiki", "research-concepts", "linker.md"), "utf8");
    expect(after).toBe(before);
  }, 30_000);
});

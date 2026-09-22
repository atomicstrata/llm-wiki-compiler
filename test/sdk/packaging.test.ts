/**
 * @file test/sdk/packaging.test.ts
 * @description Install-from-tarball packaging smoke test for the SDK library entry.
 *
 * Validates the full publish contract by running `npm pack`, installing the
 * resulting tarball into a throwaway ESM fixture project, and importing
 * `createWiki` from the installed package via a probe script.
 *
 * This catches mistakes that a local `dist/` import would miss:
 *   - Wrong/missing `exports` map entries
 *   - Files accidentally excluded from the `files` field
 *   - A shebang on the library bundle that would break `import`
 *   - Missing type declarations (`.d.ts`)
 *
 * Network-dependent: `npm install <tarball>` resolves llmwiki's ~17 runtime
 * deps fresh from the registry, so this is a developer-invoked `test:pack`
 * smoke test excluded from the default/CI `npm test` run.
 * Run explicitly with: `npm run test:pack`
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Pack already-built exact workspace dependencies alongside the standard facade. */
function packDistribution(repo: string, destination: string): string[] {
  return ["packages/llmwiki-core", "packages/llmwiki-local-workflows", "."].map(directory => {
    const output = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
      { cwd: path.join(repo, directory), encoding: "utf8" });
    const [packed] = JSON.parse(output) as Array<{ filename: string }>;
    expect(packed!.filename).toMatch(/\.tgz$/);
    return path.join(destination, packed!.filename);
  });
}

/** Mixed-package consumers must share brands, including observation contracts. */
async function verifyInstalledTypes(repo: string, fixture: string): Promise<void> {
  await writeFile(path.join(fixture, "types.ts"), `
    import { assertProductOperationOutputCurrent, type Wiki, type Sha256Digest as StandardDigest } from "llm-wiki-compiler";
    import type { WikiCore, Sha256Digest } from "@atomicstrata/llmwiki-core";
    import type { LocalWorkflowHost, WorkflowRun, WorkflowStageDef } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
    declare const wiki: Wiki;
    declare const digest: Sha256Digest;
    declare const host: LocalWorkflowHost;
    declare const run: WorkflowRun;
    declare const stage: WorkflowStageDef;
    const core: WikiCore = wiki;
    const standardDigest: StandardDigest = digest;
    const roundTrip: Sha256Digest = standardDigest;
    assertProductOperationOutputCurrent(".", run, stage, host.observations);
    void [core, roundTrip];
  `);
  execFileSync(process.execPath, [path.join(repo, "node_modules/typescript/bin/tsc"),
    "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "types.ts"],
  { cwd: fixture, stdio: "pipe" });
}

describe("packaging (slow; run via `npm run test:pack`)", () => {
  it("library entry imports from a packed tarball, no shebang, types emitted", async () => {
    const repo = process.cwd();
    execFileSync("npm", ["run", "build"], { stdio: "ignore", cwd: repo });
    expect((await readFile(path.join(repo, "dist/index.js"), "utf-8")).startsWith("#!")).toBe(false);
    await readFile(path.join(repo, "dist/index.d.ts"), "utf-8"); // throws if missing

    const out = await mkdtemp(path.join(tmpdir(), "wiki-pack-"));    // pack INTO temp
    const fixture = await mkdtemp(path.join(tmpdir(), "wiki-fix-"));
    try {
      const tarballs = packDistribution(repo, out);
      await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "f", type: "module" }));
      execFileSync("npm", ["install", "--ignore-scripts", ...tarballs], { cwd: fixture, stdio: "ignore" });
      await writeFile(path.join(fixture, "probe.mjs"), `import { createWiki } from "llm-wiki-compiler"; if (typeof createWiki !== "function") process.exit(2);`);
      execFileSync("node", ["probe.mjs"], { cwd: fixture, stdio: "ignore" });
      await verifyInstalledTypes(repo, fixture);
    } finally {
      await rm(out, { recursive: true, force: true });   // no .tgz left in the repo
      await rm(fixture, { recursive: true, force: true });
    }
  }, 180_000);
});

/**
 * @file test/sdk/installed-package-scan.test.ts
 * @description A forbidden symbol in any installed public package, including
 * local-workflows, must fail the packaging smoke's installed-file scan.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "bun:test";
import { forbiddenInstalledFiles } from "./installed-package-scan.js";

it("finds a forbidden symbol confined to installed local-workflows", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "llmwiki-pack-scan-"));
  try {
    for (const name of ["llm-wiki-compiler", "@atomicstrata/llmwiki-core", "@atomicstrata/llmwiki-local-workflows"]) {
      const dir = path.join(fixture, "node_modules", name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "index.js"), "safe");
    }
    expect(await forbiddenInstalledFiles(fixture, ["forbiddenInternalSymbol"])).toEqual([]);
    await writeFile(path.join(fixture, "node_modules", "@atomicstrata", "llmwiki-local-workflows", "index.js"), "forbiddenInternalSymbol");
    expect(await forbiddenInstalledFiles(fixture, ["forbiddenInternalSymbol"]))
      .toEqual([path.join("node_modules", "@atomicstrata", "llmwiki-local-workflows", "index.js")]);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

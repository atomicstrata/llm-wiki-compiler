/**
 * @file test/operation-bundles/operations-authority-boundary.test.ts
 * @description Static boundary guard: the production operations-authority resolver
 * is authorized ONLY for the local `operation` CLI group (§14.2). This pins that
 * split structurally — SDK and MCP source must never import the CLI-only runtime
 * constructor (`createCliOperationRuntime`) nor the resolver module directly, so a
 * future accidental import that would silently grant an SDK/MCP surface operation
 * authority fails here in CI rather than in production.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const FORBIDDEN = ["createCliOperationRuntime", "operations-authority-resolver"];

/** Every `.ts` file under one source subtree (recursively). */
async function collectSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectSources(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  }));
  return files.flat();
}

/** The forbidden references found in one subtree, as `file: token` lines. */
async function forbiddenHits(subtree: string): Promise<string[]> {
  const files = await collectSources(path.join(SRC, subtree));
  const hits: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const token of FORBIDDEN) if (text.includes(token)) hits.push(`${path.relative(SRC, file)}: ${token}`);
  }
  return hits;
}

describe("operations-authority CLI boundary", () => {
  it("SDK source never references the CLI-authorized runtime or resolver", async () => {
    expect(await forbiddenHits("sdk")).toEqual([]);
  });

  it("MCP source never references the CLI-authorized runtime or resolver", async () => {
    expect(await forbiddenHits("mcp")).toEqual([]);
  });
});

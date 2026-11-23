/**
 * @file test/sdk/installed-package-scan.ts
 * @description Scan the installed public package payloads for forbidden
 * internal symbols, using the same package set as the packaging smoke.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** Installed package names whose bytes must obey the public symbol boundary. */
export const INSTALLED_PUBLIC_PACKAGES = [
  "llm-wiki-compiler", "@atomicstrata/llmwiki-core", "@atomicstrata/llmwiki-local-workflows",
] as const;

/** Every regular file below one installed package. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
}

/** Paths of installed package files containing any forbidden symbol. */
export async function forbiddenInstalledFiles(fixture: string, symbols: readonly string[]): Promise<string[]> {
  const installed = INSTALLED_PUBLIC_PACKAGES.map((name) => path.join(fixture, "node_modules", name));
  const files = (await Promise.all(installed.map(filesUnder))).flat();
  const leaking: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (symbols.some((symbol) => text.includes(symbol))) leaking.push(path.relative(fixture, file));
  }
  return leaking;
}

/**
 * @file test/connectors/import-lint.test.ts
 * @description Detective lint keeps connector impls capability-starved.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN = [/node:fs/, /fs\/promises/, /node:child_process/, /process\.env/, /\bfetch\s*\(/, /undici/];

/** Recursively list TypeScript connector implementation files. */
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(full));
    if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("connector implementation import lint", () => {
  it("connector impl modules do not import network/fs/env capabilities", async () => {
    for (const file of await files(path.resolve("src/connectors/impl"))) {
      const text = await readFile(file, "utf8");
      for (const pattern of FORBIDDEN) expect(text, `${file} matched ${pattern}`).not.toMatch(pattern);
    }
  });
});

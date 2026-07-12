/**
 * @file test/profile-template-r3-boundary.test.ts
 * @description Structural guard keeping R3 discovery disconnected from project writes.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const R3_FILES = [
  "cache.ts", "discovery.ts", "evidence.ts", "manage.ts", "operator-lock.ts",
  "package.ts", "paths.ts", "private-root.ts", "refresh.ts", "state-parse.ts",
  "state-store.ts", "state-types.ts",
];

describe("template registry R3 boundary", () => {
  it("cannot import project installers, profile loaders, or project locks", async () => {
    const root = path.join(process.cwd(), "src/profile/templates/taps");
    const text = (await Promise.all(R3_FILES.map((file) => readFile(path.join(root, file), "utf8")))).join("\n");
    expect(text).not.toMatch(/templates\/install|profile\/load|utils\/lock\.js|writeProfile|installPackage/);
  });
});

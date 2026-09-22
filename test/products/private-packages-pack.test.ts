/**
 * @file The generic provider backend packages installed beside the compiler
 * are BUILT packages: `npm pack` yields a tarball whose entry is `dist/index.js`
 * with declarations, and that entry imports only package names (the platform,
 * the other backend), never a checkout-relative path.
 */

import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const PACKAGES = ["llmwiki-dev-backend", "llmwiki-limited-isolation-backend"] as const;
const ALLOWED_IMPORTS = new Set(["@atomicstrata/llmwiki-core", "llmwiki-dev-backend", "llmwiki-limited-isolation-backend"]);
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

/** `npm pack` one package into a fresh dir; return the tarball's entry list. */
function packEntries(name: string): { tarball: string; entries: string[] } {
  const dest = execFileSync("mktemp", ["-d", path.join(tmpdir(), "pack-XXXXXX")]).toString().trim();
  dirs.push(dest);
  const out = execFileSync("npm", ["pack", "--silent", "--pack-destination", dest], { cwd: path.join(REPO, "packages", name) }).toString();
  const tarball = path.join(dest, out.trim().split("\n").pop() as string);
  const entries = execFileSync("tar", ["-tzf", tarball]).toString().trim().split("\n");
  return { tarball, entries };
}

describe("the packed private packages install into an EMPTY consumer and import by name", () => {
  it("npm-installs the platform + the two backend tarballs beside each other and imports each package's entry", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "private-pack-out-")); dirs.push(out);
    const consumer = await mkdtemp(path.join(tmpdir(), "private-pack-consumer-")); dirs.push(consumer);
    const packInto = (dir: string): string => {
      // Global setup already built the compiler packages. Re-running their
      // prepack hooks here deletes shared chunks while CLI tests import them.
      const compilerPackage = dir === REPO || ["llmwiki-core", "llmwiki-local-workflows"].includes(path.basename(dir));
      const flags = compilerPackage ? ["--ignore-scripts"] : [];
      const printed = execFileSync("npm", ["pack", "--silent", ...flags, "--pack-destination", out], { cwd: dir }).toString();
      return path.join(out, printed.trim().split("\n").pop() as string);
    };
    const dependencies = ["llmwiki-core", "llmwiki-local-workflows", ...PACKAGES];
    const tarballs = [packInto(REPO), ...dependencies.map((name) => packInto(path.join(REPO, "packages", name)))];
    await writeFile(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", type: "module", private: true }));
    // A peer or file: dependency regression fails HERE (ERESOLVE), not in a later slice's journey.
    execFileSync("npm", ["install", ...tarballs], { cwd: consumer, stdio: ["ignore", "ignore", "pipe"] });
    const probe = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { fileURLToPath } from "node:url";
      const want = { "llmwiki-dev-backend": "createDevChannel", "llmwiki-limited-isolation-backend": "limitedIsolationLaunchPlan" };
      for (const [name, symbol] of Object.entries(want)) {
        if (!fileURLToPath(import.meta.resolve(name)).startsWith(process.cwd())) throw new Error("resolved outside the consumer: " + name);
        const mod = await import(name);
        if (typeof mod[symbol] !== "function") throw new Error(name + " does not export " + symbol);
      }
      console.log("imports ok");`], { cwd: consumer, env: { ...process.env, NODE_PATH: "" } }).toString();
    expect(probe).toContain("imports ok");
  }, 600_000);
});

describe("private packages pack as built packages", () => {
  for (const name of PACKAGES) {
    it(`${name}: the tarball ships dist/index.js + index.d.ts and imports only package names`, async () => {
      const { tarball, entries } = packEntries(name);
      expect(entries).toContain("package/dist/index.js");
      expect(entries).toContain("package/dist/index.d.ts");
      expect(entries.some((e) => e.startsWith("package/src/"))).toBe(false);
      const extracted = await mkdtemp(path.join(tmpdir(), `${name}-x-`));
      dirs.push(extracted);
      execFileSync("tar", ["-xzf", tarball, "-C", extracted]);
      const entry = await readFile(path.join(extracted, "package", "dist", "index.js"), "utf8");
      const isBuiltin = (spec: string): boolean => builtinModules.includes(spec.replace(/^node:/, ""));
      // Inspect actual import/export statements rather than strings inside bundled programs.
      const imports = [...entry.matchAll(/^(?:import|export)\b[^\n]*?\bfrom "([^"]+)"/gm)].map((m) => m[1]!).filter((spec) => !isBuiltin(spec));
      for (const spec of imports) expect(ALLOWED_IMPORTS.has(spec), `unexpected import ${spec}`).toBe(true);
      expect(entry).not.toMatch(/\.\.\/\.\.\/src\//);
      // A checkout-relative import would be BUNDLED by the build: the isolation backend must
      // not carry its own copy of the dev backend's channel launcher.
      if (name === "llmwiki-limited-isolation-backend") expect(entry).not.toContain("function createDevChannel");
    }, 120_000);
  }
});

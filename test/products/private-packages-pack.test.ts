/**
 * @file The generic provider backend packages installed beside the compiler
 * are BUILT packages: `npm pack` yields a tarball whose entry is `dist/index.js`
 * with declarations, and that entry imports only package names (the platform,
 * the other backend), never a checkout-relative path.
 *
 * Every package is packed once, all at the same time, before the tests run. A
 * backend's prepack rebuilds it (several seconds), so the install test and the
 * tarball checks share those tarballs rather than packing again.
 */

import { execFile, execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const exec = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, "..", "..");
const PACKAGES = ["llmwiki-dev-backend", "llmwiki-limited-isolation-backend"] as const;
const COMPILER_PACKAGES = ["llmwiki-core", "llmwiki-local-workflows"] as const;
const ALLOWED_IMPORTS = new Set(["@atomicstrata/llmwiki-core", "llmwiki-dev-backend", "llmwiki-limited-isolation-backend"]);
/** Packing builds both backends; on a CI runner that takes well over the default hook timeout. */
const PACK_TIMEOUT_MS = 300_000;
const dirs: string[] = [];
let tarballs: Map<string, string>;

/** A fresh temp dir, removed after the file's tests. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * `npm pack` one package directory into `out`; return the tarball path.
 * Global setup already built the compiler packages: re-running their prepack
 * hooks deletes shared chunks while CLI tests import them, so they skip scripts.
 */
async function pack(dir: string, out: string, isCompilerPackage: boolean): Promise<string> {
  const flags = isCompilerPackage ? ["--ignore-scripts"] : [];
  const { stdout } = await exec("npm", ["pack", "--silent", ...flags, "--pack-destination", out], { cwd: dir });
  return path.join(out, stdout.trim().split("\n").pop() as string);
}

beforeAll(async () => {
  const out = await tempDir("private-pack-out-");
  const packed = await Promise.all([
    pack(REPO, out, true).then((tarball) => ["llm-wiki-compiler", tarball] as const),
    ...COMPILER_PACKAGES.map(async (name) => [name, await pack(path.join(REPO, "packages", name), out, true)] as const),
    ...PACKAGES.map(async (name) => [name, await pack(path.join(REPO, "packages", name), out, false)] as const),
  ]);
  tarballs = new Map(packed);
}, PACK_TIMEOUT_MS);
afterAll(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

describe("the packed private packages install into an EMPTY consumer and import by name", () => {
  it("npm-installs the platform + the two backend tarballs beside each other and imports each package's entry", async () => {
    const consumer = await tempDir("private-pack-consumer-");
    await writeFile(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", type: "module", private: true }));
    // A peer or file: dependency regression fails HERE (ERESOLVE), not in a later slice's journey.
    execFileSync("npm", ["install", ...tarballs.values()], { cwd: consumer, stdio: ["ignore", "ignore", "pipe"] });
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
      const tarball = tarballs.get(name)!;
      const entries = execFileSync("tar", ["-tzf", tarball]).toString().trim().split("\n");
      expect(entries).toContain("package/dist/index.js");
      expect(entries).toContain("package/dist/index.d.ts");
      expect(entries.some((e) => e.startsWith("package/src/"))).toBe(false);
      const extracted = await tempDir(`${name}-x-`);
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
    });
  }
});

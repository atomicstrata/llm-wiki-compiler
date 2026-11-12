/**
 * Resolve and invoke the repository's build tool without shell-specific npm
 * wrappers. Dependency builds run with the same runtime executing this script.
 *
 * Each build output directory also gets an empty `tsconfig.json`. Bun applies
 * the nearest tsconfig's `paths` at RUNTIME, and the root config maps the
 * `@atomicstrata/*` packages to `src/` for type-checking and tests. Without a
 * nearer, empty config, `bun dist/cli.js` in this repository would quietly load
 * the core from source instead of the built packages it is meant to exercise.
 * Published packages exclude the stub; installs carry no root tsconfig anyway.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const require = createRequire(import.meta.url);
const exec = promisify(execFile);

/** Resolve the installed CLI from its manifest instead of hardcoding its layout. */
function resolveTsupCli(): string {
  const manifestPath = require.resolve("tsup/package.json");
  const { bin } = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin: string | Record<string, string>;
  };
  const entry = typeof bin === "string" ? bin : bin.tsup;
  return path.join(path.dirname(manifestPath), entry);
}

/** Shield one build output directory from the repository's tsconfig `paths`. */
export function isolateFromSourcePaths(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "tsconfig.json"), "{}\n");
}

/**
 * Build core and the externalized engine side by side, then allow facade
 * assembly. Neither reads the other's output: both resolve
 * `@atomicstrata/*` to `src/` through the root tsconfig `paths`, so their
 * declaration builds (the slow part) can overlap.
 */
export async function buildCompilerDependencies(root: string): Promise<void> {
  const outputs = await Promise.all(["llmwiki-core", "llmwiki-local-workflows"].map(async (name) => {
    const packageDir = path.join(root, "packages", name);
    const { stdout } = await exec(process.execPath, [resolveTsupCli()], {
      cwd: packageDir, maxBuffer: 4 * 1024 * 1024,
    });
    isolateFromSourcePaths(path.join(packageDir, "dist"));
    return stdout;
  }));
  for (const stdout of outputs) process.stdout.write(stdout);
}

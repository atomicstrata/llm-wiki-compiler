/**
 * Resolve and invoke the repository's build tool without shell-specific npm
 * wrappers. Dependency builds and test setup use the same Node executable.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const require = createRequire(import.meta.url);
const exec = promisify(execFile);

/** Resolve the installed CLI from its manifest instead of hardcoding its layout. */
export function resolveTsupCli(): string {
  const manifestPath = require.resolve("tsup/package.json");
  const { bin } = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin: string | Record<string, string>;
  };
  const entry = typeof bin === "string" ? bin : bin.tsup;
  return path.join(path.dirname(manifestPath), entry);
}

/** Build core before the externalized engine, then allow facade assembly. */
export async function buildCompilerDependencies(root: string): Promise<void> {
  for (const name of ["llmwiki-core", "llmwiki-local-workflows"]) {
    const { stdout } = await exec(process.execPath, [resolveTsupCli()], {
      cwd: path.join(root, "packages", name), maxBuffer: 4 * 1024 * 1024,
    });
    process.stdout.write(stdout);
  }
}

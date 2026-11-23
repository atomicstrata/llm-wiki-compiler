/**
 * @file scripts/public-boundary/composition.mjs
 * @description The ONE derivation of the core package's per-module entries,
 * and the release composition built on it.
 *
 * The CLI imports a command's core module by its own subpath
 * (`@atomicstrata/llmwiki-core/modules/commands/ingest`) and loads it only when
 * that command runs. Those subpaths are read from the import statements of the
 * CLI's own files: every file in `src/cli/`, and the `workflow` command modules
 * in `src/commands/`. The ordinary core build
 * (`packages/llmwiki-core/tsup.config.ts`), the public release builder and the
 * release gate all call {@link coreModuleNames}, so the module set they build,
 * map, predict and hash cannot drift apart.
 *
 * It is fail-closed. A captured name that is not plain lower-case path
 * segments (no `..`, no leading `/`, no dot, no capital), or that names no
 * regular file `src/<name>.ts`, throws. Only the exact derived names are
 * mapped: any other `@atomicstrata/llmwiki-core/...` specifier stays unmapped,
 * and the import graph keeps reporting it as unresolved. Nothing here widens
 * the boundary: the manifest is not changed, and an internal or product module
 * reached through a mapped entry is still refused by the graph check.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** The package whose `./modules/*` subpaths are the per-module entries. */
const CORE_PACKAGE = "@atomicstrata/llmwiki-core";

/** One module name: lower-case path segments only. */
const MODULE_NAME = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/u;

/** A per-module import in CLI source text (the same expression the ordinary core build used). */
const MODULE_IMPORT = /"@atomicstrata\/llmwiki-core\/modules\/([^"]+)"/gu;

/** The CLI files the module set is read from: every file in `src/cli/`, and `src/commands/workflow*.ts`. */
function cliSourceFiles(root) {
  const cliDir = path.join(root, "src", "cli");
  const commandsDir = path.join(root, "src", "commands");
  return [
    ...readdirSync(cliDir).sort().map((file) => path.join(cliDir, file)),
    ...readdirSync(commandsDir).filter((file) => /^workflow.*\.ts$/u.test(file)).sort().map((file) => path.join(commandsDir, file)),
  ];
}

/** Throw unless `name` is plain lower-case path segments naming the regular file `src/<name>.ts`. */
function assertModuleName(root, name) {
  if (!MODULE_NAME.test(name)) throw new Error(`core module name ${JSON.stringify(name)} is not plain lower-case path segments`);
  const source = path.join(root, "src", `${name}.ts`);
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`core module ${name} has no source file src/${name}.ts`);
}

/** Every per-module name the CLI imports, sorted; throws on a name that is malformed or has no source. */
export function coreModuleNames(root) {
  const names = new Set(cliSourceFiles(root).flatMap((file) => [...readFileSync(file, "utf8").matchAll(MODULE_IMPORT)].map((match) => match[1])));
  for (const name of names) assertModuleName(root, name);
  return [...names].sort();
}

/** The tsup entry map of the per-module entries: `modules/<name>` to the absolute `src/<name>.ts`. */
export function coreModuleEntries(root) {
  return Object.fromEntries(coreModuleNames(root).map((name) => [`modules/${name}`, path.join(root, "src", `${name}.ts`)]));
}

/**
 * The public release composition with the per-module entries added, derived
 * from the manifest without changing it.
 *
 * @returns `moduleNames`; `entries` (the manifest's release entries plus one
 *   `core:modules/<name>` entry per module); `packageEntries` (the manifest's
 *   plus one exact `@atomicstrata/llmwiki-core/modules/<name>` mapping per
 *   module); `packages` (the public packages, the core package's entry keys
 *   extended with the module entries); and `graphConfig` for `buildGraph`.
 */
export function releaseComposition(root, manifest) {
  const moduleNames = coreModuleNames(root);
  const moduleEntry = (name) => [`core:modules/${name}`, `src/${name}.ts`];
  const entries = { ...manifest.publicRelease.entries, ...Object.fromEntries(moduleNames.map(moduleEntry)) };
  const packageEntries = { ...manifest.packageEntries, ...Object.fromEntries(moduleNames.map((name) => [`${CORE_PACKAGE}/modules/${name}`, `src/${name}.ts`])) };
  const packages = manifest.publicPackages.map((entry) => (entry.name !== CORE_PACKAGE ? entry
    : { ...entry, entries: [...entry.entries, ...moduleNames.map((name) => `core:modules/${name}`)] }));
  const graphConfig = { packageEntries, inRepositoryPackages: manifest.publicRelease.inRepositoryPackages, allowedConstructs: manifest.graph.allowedConstructs };
  return { moduleNames, entries, packageEntries, packages, graphConfig };
}

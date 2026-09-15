/** Collect semantic test diagnostics without emitting build artifacts. */
import ts from "typescript";
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";

/** Stable repository-relative paths for diagnostics and metadata. */
function relativeFile(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** Configuration/global errors cannot be hidden inside a per-file baseline. */
function rejectDiagnostics(diagnostics: readonly ts.Diagnostic[]): void {
  if (diagnostics.length) throw new Error(ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  }));
}

/** Inspect disk independently of TypeScript globs, which omit dot-prefixed names. */
function listCheckedSources(root: string): string[] {
  const extensions = [".ts", ".tsx", ".mts", ".cts"];
  const files: string[] = [];
  for (const name of ["src", "test"]) {
    const directory = path.join(root, name);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
        files.push(path.join(entry.parentPath, entry.name));
      }
    }
  }
  return files;
}

/** Load test settings and reject configurations that omit checked source files. */
function readTestConfig(root: string): ts.ParsedCommandLine {
  const file = path.join(root, "tsconfig.test.json");
  const loaded = ts.readConfigFile(file, ts.sys.readFile);
  if (loaded.error) rejectDiagnostics([loaded.error]);
  const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root, undefined, file);
  rejectDiagnostics(config.errors);
  if (config.options.noEmit !== true) throw new Error("Test type-check requires noEmit: true");
  const included = new Set(config.fileNames.map((name) => path.resolve(name)));
  const expected = listCheckedSources(root);
  const missing = expected.filter((name) => !included.has(path.resolve(name)));
  if (missing.length) throw new Error(`Unchecked files: ${missing.map((name) => relativeFile(root, name)).join(", ")}`);
  return config;
}

/** Pin effective options and recursive selection without embedding checkout paths. */
function configurationDigest(root: string, config: ts.ParsedCommandLine): string {
  const value = { options: config.options, include: config.raw.include, exclude: config.raw.exclude };
  const serialized = JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "string" && path.isAbsolute(entry)) return relativeFile(root, entry);
    return entry;
  });
  return createHash("sha256").update(serialized).digest("hex");
}

/** Check a repository using its separate test configuration. */
export function collectTestDiagnostics(root: string): { counts: Record<string, number>; checkedFiles: string[]; configuration: string } {
  const config = readTestConfig(root);
  const program = ts.createProgram(config.fileNames, config.options);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((entry) => entry.category === ts.DiagnosticCategory.Error);
  rejectDiagnostics(diagnostics.filter((entry) => !entry.file));
  const counts: Record<string, number> = {};
  for (const diagnostic of diagnostics) {
    const file = relativeFile(root, diagnostic.file!.fileName);
    counts[file] = (counts[file] ?? 0) + 1;
  }
  return {
    counts: Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))),
    checkedFiles: config.fileNames.map((file) => relativeFile(root, file)).sort(),
    configuration: configurationDigest(root, config),
  };
}

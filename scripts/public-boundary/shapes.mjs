/**
 * @file scripts/public-boundary/shapes.mjs
 * @description The SHAPE check of the release gate: the public facades must
 * keep the public baseline's declarations usable, not merely its names.
 *
 * The baseline source is extracted read-only from its recorded commit into a
 * scratch directory inside the repository (so it resolves the installed type
 * packages). One TypeScript program then loads the baseline facade and the
 * public facade side by side, each resolving the in-repository package
 * specifiers to ITS OWN tree, and type-checks a generated probe:
 *
 *   value export   `const v: typeof Baseline.name = Candidate.name`
 *   type export    `const t: Baseline.Name = (undefined as unknown) as Candidate.Name`
 *   type, reverse  `const r: Candidate.Name = (undefined as unknown) as Baseline.Name`
 *   type, keys     `const k: keyof Candidate.Name = (undefined as unknown) as keyof Baseline.Name`
 *
 * so every baseline value and non-generic type must accept the candidate's
 * (FORWARD: what the library produces still fits what callers expect), and
 * every candidate non-generic type must accept the baseline's (REVERSE: what a
 * caller built for the baseline type still fits). The reverse probe is what
 * catches a NARROWED type: a newly required member, a dropped union member or
 * a brand added to a plain alias. KEY RETENTION is probed separately for
 * every non-generic type, named outputs included: a removed OPTIONAL member
 * passes both assignment directions, so only the key probe sees it. A
 * diagnostic is a finding, with the `direction` it was found in. Generic types
 * are counted, not probed.
 *
 * LIBRARY-OWNED OUTPUT TYPES. A type only the library constructs may gain
 * members without breaking a caller that only receives it. That is never
 * assumed: it is a NAMED policy in the manifest
 * (`surface.shapePolicies.libraryOutputTypes`), validated against its facade
 * and its actual declaration by `./shape-policies.mjs`; an invalid, duplicate
 * or unknown policy is rejected as a finding and never applied. For an applied
 * policy the reverse probe is a projection onto the baseline's members,
 * `Pick<Candidate.Name, keyof Baseline.Name & keyof Candidate.Name>` (the key
 * probe above guarantees no baseline key is missing from it), and a second
 * probe requires the added member names to be within the allowed list. It
 * does NOT protect a caller that constructs or implements the type itself (a
 * complete mock, a class implementing it): such a caller must add the members.
 * No diagnostic is filtered and no type is exempt by kind.
 *
 * TWO COPIES, ONE IDENTITY. The trees are two copies of the source, so a
 * declaration with identity (a `unique symbol` brand, a class with private
 * members) differs between them even when nothing changed. Two rules make the
 * comparison structural without hiding anything:
 * - UNCHANGED MODULES ARE ONE MODULE. A baseline module whose bytes equal the
 *   candidate's, and whose every repository import is such a module too, is
 *   resolved to the candidate's file.
 * - MATCHED BRANDS ARE ONE BRAND (`./brands.mjs`). A brand whose declaration
 *   corresponds in both trees (same module, owner path, name and form, read
 *   from the syntax tree) is rewritten, in the
 *   text the comparison reads only, to one shared symbol. Everything else in
 *   the type is then compared as written, so a real break beside a brand is
 *   reported. A brand only one tree has is not unified, is listed
 *   (`brandsOnlyInOneTree`), and fails in whichever direction no longer
 *   accepts it: a dropped brand forward, an added brand in reverse.
 * No diagnostic is discarded. A class whose private declarations differ only
 * by copy cannot be told from one that changed, so it is a finding of its own
 * kind (`nominal-declaration-unverified`), never a pass.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pairBrands, unifyBrandText } from "./brands.mjs";
import { bindPolicies, screenPolicies } from "./shape-policies.mjs";

const ts = createRequire(import.meta.url)("typescript");

/** Diagnostic text of a class identity difference: two copies, or a real change; the check cannot tell which. */
const NOMINAL_MARKERS = ["separate declarations of a private property", "Types have separate declarations"];

/** The facades compared, as repository-relative source paths in both trees. */
const FACADES = [{ key: "core", baseline: "src/core-index.ts" }, { key: "root", baseline: "src/index.ts" }];

/** A cached baseline needs both its sources and its own root manifest. */
function hasBaselineInputs(directory) {
  const optional = { throwIfNoEntry: false };
  return lstatSync(directory, optional)?.isDirectory()
    && lstatSync(path.join(directory, "src"), optional)?.isDirectory()
    && lstatSync(path.join(directory, "package.json"), optional)?.isFile();
}

/** Extract both baseline inputs from the recorded commit before publishing the cache. */
function extractBaseline(root, manifest, commit) {
  const parent = path.join(root, path.dirname(manifest.publicRelease.stageDir), "baseline-with-manifest-v1");
  const directory = path.join(parent, commit);
  if (lstatSync(directory, { throwIfNoEntry: false })) {
    if (!hasBaselineInputs(directory)) throw new Error("baseline cache is missing src or package.json");
    return directory;
  }

  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(path.join(parent, ".extract-"));
  try {
    const archive = execFileSync("git", ["-C", root, "archive", commit, "src", "package.json"], { maxBuffer: 512 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", temporary], { input: archive });
    if (!hasBaselineInputs(temporary)) throw new Error("baseline archive is missing src or package.json");
    try {
      renameSync(temporary, directory);
    } catch (error) {
      // A competing checker may have published a complete cache first.
      if ((error.code !== "EEXIST" && error.code !== "ENOTEMPTY") || !hasBaselineInputs(directory)) throw error;
    }
    return directory;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** The in-repository package entries of one tree: the candidate's public composition, or the baseline's own facades. */
function packageEntriesOf(root, manifest, baselineDir) {
  const candidate = Object.fromEntries(Object.entries(manifest.packageEntries).map(([name, file]) => [name, path.join(root, file)]));
  const internalOf = Object.fromEntries(Object.values(manifest.surface.facades).map((facade) => [facade.public, facade.internal]));
  const baseline = Object.fromEntries(Object.entries(manifest.packageEntries).map(([name, file]) => [name, path.join(baselineDir, internalOf[file] ?? file)]));
  return { candidate, baseline };
}

/** Repository-relative `.ts` sources under `dir/src`. */
function sourcesUnder(dir, prefix = "src") {
  return readdirSync(path.join(dir, prefix)).flatMap((name) => {
    const relative = `${prefix}/${name}`;
    if (statSync(path.join(dir, relative)).isDirectory()) return sourcesUnder(dir, relative);
    return name.endsWith(".ts") ? [relative] : [];
  });
}

/** The repository modules one source imports: relative targets as `.ts` paths, and whether it names an in-repository package. */
function repositoryImportsOf(text, file, packageNames) {
  const specifiers = [...text.matchAll(/(?:from|import\()\s*["']([^"']+)["']/gu)].map((match) => match[1]);
  const relative = specifiers.filter((specifier) => specifier.startsWith(".")).map((specifier) => path.posix.join(path.posix.dirname(file), specifier).replace(/\.js$/u, ".ts"));
  return { relative, usesPackage: specifiers.some((specifier) => packageNames.some((name) => specifier === name || specifier.startsWith(`${name}/`))) };
}

/**
 * The baseline modules that are the SAME module in the candidate: equal
 * bytes, no in-repository package import, and every relative import in the
 * set too (the greatest such set, so a cycle of unchanged modules stays in).
 */
function unchangedModules(root, baselineDir, packageNames) {
  const imports = new Map();
  for (const file of sourcesUnder(baselineDir)) {
    if (!existsSync(path.join(root, file))) continue;
    const text = readFileSync(path.join(baselineDir, file), "utf8");
    if (text !== readFileSync(path.join(root, file), "utf8")) continue;
    const found = repositoryImportsOf(text, file, packageNames);
    if (!found.usesPackage) imports.set(file, found.relative.filter((target) => target.endsWith(".ts")));
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [file, targets] of imports) {
      if (targets.every((target) => imports.has(target))) continue;
      imports.delete(file);
      changed = true;
    }
  }
  return new Set(imports.keys());
}

/** The tree a file belongs to and its repository-relative path, or null for a file outside both. */
function locate(fileName, shared, baselineDir) {
  for (const base of [baselineDir, shared.root]) {
    if (fileName.startsWith(`${base}${path.sep}src${path.sep}`)) return path.relative(base, fileName).split(path.sep).join("/");
  }
  return null;
}

/**
 * A compiler host that resolves in-repository package specifiers per tree and
 * an unchanged baseline module to the candidate's file, and that reads a
 * module with matched brands as its brand-unified text.
 */
function hostFor(options, entries, baselineDir, shared) {
  const host = ts.createCompilerHost(options);
  host.resolveModuleNameLiterals = (literals, containingFile) => literals.map((literal) => {
    const own = containingFile.startsWith(`${baselineDir}${path.sep}`) ? entries.baseline : entries.candidate;
    const mapped = own[literal.text];
    if (mapped !== undefined) return { resolvedModule: { resolvedFileName: mapped, extension: ts.Extension.Ts, isExternalLibraryImport: false } };
    const resolved = ts.resolveModuleName(literal.text, containingFile, options, host);
    const file = resolved.resolvedModule?.resolvedFileName;
    if (file === undefined || !file.startsWith(`${baselineDir}${path.sep}`)) return resolved;
    const relative = path.relative(baselineDir, file).split(path.sep).join("/");
    return shared.modules.has(relative) ? { resolvedModule: { ...resolved.resolvedModule, resolvedFileName: path.join(shared.root, relative) } } : resolved;
  });
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const relative = locate(fileName, shared, baselineDir);
    const keys = relative === null ? undefined : shared.brands.shared.get(relative);
    if (keys === undefined) return readSource(fileName, languageVersion, ...rest);
    return ts.createSourceFile(fileName, unifyBrandText(readFileSync(fileName, "utf8"), keys, shared.brandsModule, fileName), languageVersion, true);
  };
  return host;
}

/** The export a baseline name resolves to, classified for the probe. */
function classifyExport(checker, symbol) {
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const isValue = (target.flags & ts.SymbolFlags.Value) !== 0;
  const isType = (target.flags & ts.SymbolFlags.Type) !== 0;
  const parameters = isType ? (target.declarations ?? []).flatMap((declaration) => declaration.typeParameters ?? []).length : 0;
  return { isValue, isType, isGeneric: parameters > 0 };
}

/** What each probe direction asks. */
const FORWARD = "baseline-accepts-candidate";
const REVERSE = "candidate-accepts-baseline";
const PROJECTED = "candidate-accepts-baseline-members";
const ADDITIONS = "added-members-within-policy";
const RETAINED = "baseline-keys-retained";

/** The reverse probe lines of one non-generic type: the whole type, or for a named output type its baseline-key projection and its additions. */
function reverseProbes(name, policy) {
  const baselineValue = `(undefined as unknown) as B.${name}`;
  if (policy === undefined) return [{ direction: REVERSE, text: `C.${name} = ${baselineValue}` }];
  const allowed = policy.allowedAdditions.length === 0 ? "never" : policy.allowedAdditions.map((member) => JSON.stringify(member)).join(" | ");
  return [
    { direction: PROJECTED, text: `Pick<C.${name}, keyof B.${name} & keyof C.${name}> = ${baselineValue}` },
    { direction: ADDITIONS, text: `${allowed} = (undefined as unknown) as Exclude<keyof C.${name}, keyof B.${name}>` },
  ];
}

/** The probe source for one facade pair, with the name and direction each probe line checks. */
function probeFor(checker, baselineSource, files, names, policies) {
  const moduleSymbol = checker.getSymbolAtLocation(baselineSource);
  const exports = new Map(checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.name, symbol]));
  const lines = [`import * as B from ${JSON.stringify(files.baseline)};`, `import * as C from ${JSON.stringify(files.candidate)};`];
  const lineNames = new Map();
  const skipped = { generic: [], notExportedByBaselineSource: [] };
  const add = (name, direction, declaration) => { lineNames.set(lines.length + 1, { name, direction }); lines.push(`export const p_${lines.length}: ${declaration};`); };
  for (const name of names) {
    const symbol = exports.get(name);
    if (symbol === undefined) { skipped.notExportedByBaselineSource.push(name); continue; }
    const kind = classifyExport(checker, symbol);
    if (kind.isValue) add(name, FORWARD, `typeof B.${name} = C.${name}`);
    if (kind.isType && kind.isGeneric) { skipped.generic.push(name); continue; }
    if (!kind.isType) continue;
    add(name, FORWARD, `B.${name} = (undefined as unknown) as C.${name}`);
    add(name, RETAINED, `keyof C.${name} = (undefined as unknown) as keyof B.${name}`);
    for (const probe of reverseProbes(name, policies.get(name))) add(name, probe.direction, probe.text);
  }
  return { text: `${lines.join("\n")}\n`, lineNames, skipped };
}

/** The innermost message of a diagnostic chain: the difference the outer lines only lead to. */
function terminalMessage(messageText) {
  let node = messageText;
  while (typeof node !== "string" && node.next !== undefined && node.next.length > 0) node = node.next[node.next.length - 1];
  return typeof node === "string" ? node : node.messageText;
}

/** The scratch directory the comparison writes its probe and brand module in. */
function scratchDir(root, manifest) {
  const directory = path.join(root, path.dirname(manifest.publicRelease.stageDir), "shapes");
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** One probe diagnostic as a finding record; a class identity difference keeps its own kind. */
function findingOf(facade, probe, source, diagnostic) {
  const line = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1;
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  const isNominal = NOMINAL_MARKERS.some((marker) => message.includes(marker));
  const probed = probe.lineNames.get(line) ?? { name: `(line ${line})`, direction: "unknown" };
  return { facade: facade.key, name: probed.name, direction: probed.direction, code: diagnostic.code, kind: isNominal ? "nominal-declaration-unverified" : "shape",
    message: message.slice(0, 400), terminal: terminalMessage(diagnostic.messageText).slice(0, 300) };
}

/** A rejected policy as a finding: it is never applied, and the gate fails on it. */
function policyFinding(facade, rejection) {
  return { facade, name: rejection.policy, direction: "policy", code: 0, kind: "policy-invalid", message: rejection.reason, terminal: rejection.reason };
}

/** Compare one facade pair; returns its findings, counts and the policies that bound to it. */
function compareFacade(context, facade, names) {
  const { root, manifest, baselineDir, options, entries, shared, policies } = context;
  const baselineFile = path.join(baselineDir, facade.baseline);
  const candidateFile = path.join(root, manifest.surface.facades[facade.key].public);
  const probeFile = path.join(scratchDir(root, manifest), `${facade.key}-probe.ts`);
  const first = ts.createProgram({ rootNames: [baselineFile, candidateFile], options, host: hostFor(options, entries, baselineDir, shared) });
  const files = { baseline: baselineFile.replace(/\.ts$/u, ".js"), candidate: candidateFile.replace(/\.ts$/u, ".js") };
  const checker = first.getTypeChecker();
  const bound = bindPolicies({ facade: facade.key, checker: { baseline: checker, candidate: checker }, root,
    sources: { baseline: first.getSourceFile(baselineFile), candidate: first.getSourceFile(candidateFile) }, classify: (symbol) => classifyExport(checker, symbol) }, policies);
  const probe = probeFor(checker, first.getSourceFile(baselineFile), files, names, bound.applied);
  writeFileSync(probeFile, probe.text);
  const program = ts.createProgram({ rootNames: [baselineFile, candidateFile, probeFile], options, host: hostFor(options, entries, baselineDir, shared), oldProgram: first });
  const source = program.getSourceFile(probeFile);
  const findings = [...bound.rejected.map((rejection) => policyFinding(facade.key, rejection)),
    ...program.getSemanticDiagnostics(source).map((diagnostic) => findingOf(facade, probe, source, diagnostic))];
  return { facade: facade.key, probed: probe.lineNames.size, skipped: probe.skipped, findings, applied: [...bound.applied.keys()].map((name) => `${facade.key}:${name}`) };
}

/** Every repository-relative `.ts` source either tree has. */
function sourcesOfBoth(root, baselineDir) {
  return [...new Set([...sourcesUnder(baselineDir), ...sourcesUnder(root)])].sort();
}

/**
 * Compare a candidate tree's public facades with a baseline tree's.
 *
 * @param baselineDir - The baseline source tree (its own `src/`).
 * @param baselineExports - The recorded baseline export names per facade key.
 * @returns Findings per facade; `passed` only when there is none. A baseline
 *   name the baseline source itself does not export is a finding.
 */
export function compareShapes(root, manifest, baselineDir, baselineExports) {
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
    esModuleInterop: true, skipLibCheck: true, noEmit: true, resolveJsonModule: true, allowImportingTsExtensions: true, types: ["node"], typeRoots: [path.join(root, "node_modules/@types")] };
  const brands = pairBrands(root, baselineDir, sourcesOfBoth(root, baselineDir));
  const brandsModule = path.join(scratchDir(root, manifest), "shared-brands.ts");
  writeFileSync(brandsModule, brands.moduleText);
  const shared = { root, brands, brandsModule, modules: unchangedModules(root, baselineDir, Object.keys(manifest.packageEntries)) };
  const screened = screenPolicies(manifest.surface.shapePolicies?.libraryOutputTypes ?? [], FACADES.map((facade) => facade.key));
  const context = { root, manifest, baselineDir, options, entries: packageEntriesOf(root, manifest, baselineDir), shared, policies: screened.valid };
  const facades = FACADES.map((facade) => compareFacade(context, facade, baselineExports[facade.key]));
  const findings = [...screened.rejected.map((rejection) => policyFinding("manifest", rejection)), ...facades.flatMap((facade) => [...facade.findings,
    ...facade.skipped.notExportedByBaselineSource.map((name) => ({ facade: facade.facade, name, code: 0, kind: "baseline-name-not-exported", message: "recorded baseline name is not exported by the baseline source" }))])];
  const unifiedBrands = [...brands.shared.values()].reduce((total, keys) => total + keys.size, 0);
  const rejectedPolicies = findings.filter((finding) => finding.kind === "policy-invalid").map((finding) => ({ policy: finding.name, reason: finding.message }));
  return { unchangedModules: shared.modules.size, unifiedBrands, brandsOnlyInOneTree: brands.unmatched, outputPolicies: facades.flatMap((facade) => facade.applied).sort(), rejectedPolicies,
    facades: facades.map(({ findings: _dropped, ...rest }) => rest), findings, passed: findings.length === 0 };
}

/**
 * Check that the public facades keep every baseline declaration assignable.
 * The baseline tree is extracted read-only from its recorded commit.
 */
export function checkShapes(root, manifest, baseline) {
  return { baselineCommit: baseline.commit, ...compareShapes(root, manifest, extractBaseline(root, manifest, baseline.commit), baseline.exports) };
}

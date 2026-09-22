/**
 * @file test/workflow-history-boundary.test.ts
 * @description Keeps authenticated passive history independent of the local
 * execution engine, with stable compatibility exports and non-creating reads.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { literalModuleImports } from "./fixtures/module-imports.js";
import { SRC_DIR, srcTsFiles } from "./fixtures/src-tree.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import * as history from "../src/workflow-history/store.js";
import * as legacy from "../src/workflows/store.js";
import { loadRunKey } from "../src/workflow-history/integrity.js";
import { WorkflowProcessAuthorityError } from "../src/workflow-history/process-authority.js";
import { WorkflowProcessAuthorityError as LegacyAuthorityError } from "../src/workflows/process-authority.js";
import { isTrustedWriteGranted } from "../src/trust/trusted-write.js";
import { isTrustedWriteGranted as legacyGrant } from "../src/workflows/trusted-write.js";
import * as integrity from "../src/workflow-history/integrity.js";
import * as legacyIntegrity from "../src/workflows/integrity.js";
import * as status from "../src/workflow-history/status.js";
import * as legacyStatus from "../src/workflows/status.js";
import * as gates from "../src/workflow-history/gates.js";
import * as legacyGates from "../src/workflows/gates.js";
import * as definition from "../src/workflow-history/definition.js";
import { startWorkflow, lookupWorkflowDef } from "../src/workflows/start.js";
import { mapStageId } from "../src/workflows/adapt.js";
import { isTerminalStatus } from "../src/workflows/with-lock.js";
import { installWorkflowProfile } from "./fixtures/workflow-profile.js";

const ctx = useConfinementRoots("workflow-history");

const PACKAGE_ENTRIES: Record<string, string> = {
  "@atomicstrata/llmwiki-core/compiler-cli": "compiler-cli.ts",
  "@atomicstrata/llmwiki-core": "core-index.ts",
  "@atomicstrata/llmwiki-core/compiler-sdk": "sdk/compiler-composition.ts",
  "@atomicstrata/llmwiki-core/compiler-legacy-workflows": "local-workflow-host/legacy-composition.ts",
  "@atomicstrata/llmwiki-core/local-workflow-host": "local-workflow-host/index.ts",
  "@atomicstrata/llmwiki-core/local-workflow-contracts": "local-workflow-host/shared-contracts.ts",
  "@atomicstrata/llmwiki-local-workflows": "local-workflows/index.ts",
  "llm-wiki-compiler": "index.ts",
};

/** The core consumers whose passive imports must not reintroduce execution. */
const PASSIVE_CONSUMERS = [
  "artifacts/apply.ts", "preparations/workflow-parent.ts", "profile/templates/corpus.ts",
  "profile/templates/history-audit.ts", "export/okf/bundle-block.ts", "linter/workflow-run-rule.ts",
  "viewer/server.ts", "viewer/workflow-artifact.ts", "viewer/workflow-run-projection.ts",
  "viewer/workflow-run-facts.ts", "viewer/workflow-runs.ts",
];

/** Generic CLI helpers intentionally implemented and exported by core. */
const CORE_CLI_HELPERS = new Set(["cli/input-parsers.ts", "cli/provider-option.ts", "cli/shared.ts"]);

/** Reject standard composition while allowing only the named generic helpers. */
function isStandardComposition(file: string): boolean {
  return /^(?:cli\/|commands\/workflow|mcp\/workflow)/.test(file) && !CORE_CLI_HELPERS.has(file);
}

/** Snapshot every fixture path and file byte, distinguishing empty directories. */
async function snapshot(root: string): Promise<Array<[string, string | null]>> {
  const entries = (await readdir(root, { recursive: true })).sort();
  return Promise.all(entries.map(async (entry): Promise<[string, string | null]> => {
    const file = path.join(root, entry);
    return [entry, (await stat(file)).isDirectory() ? null : (await readFile(file)).toString("base64")];
  }));
}

/** Collect static and literal dynamic module edges using the TypeScript parser. */
function dependencies(file: string): string[] {
  return literalModuleImports(file).flatMap(specifier => {
    if (specifier.startsWith(".")) return [path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts"))];
    const entry = PACKAGE_ENTRIES[specifier];
    return entry ? [path.join(SRC_DIR, entry)] : [];
  });
}

/** Follow local imports transitively, including type-only edges. */
function engineEdges(entries: string[]): string[] {
  const pending = [...entries];
  const seen = new Set<string>();
  const offending: string[] = [];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const dependency of dependencies(file)) {
      if (["workflows", "local-workflows"].some(dir => dependency.startsWith(path.join(SRC_DIR, dir) + path.sep))
        || ["index.ts", "cli.ts", "sdk/wiki.ts", "sdk/workflow-facade.ts"].some(file => dependency === path.join(SRC_DIR, file))
        || isStandardComposition(path.relative(SRC_DIR, dependency))) {
        offending.push(`${path.relative(SRC_DIR, file)} -> ${path.relative(SRC_DIR, dependency)}`);
      } else pending.push(dependency);
    }
  }
  return offending;
}

describe("core-owned passive workflow history", () => {
  it("cannot reach the local execution engine through imports or re-exports", () => {
    const entries = srcTsFiles().filter(file => file.startsWith("workflow-history/"))
      .map(file => path.join(SRC_DIR, file));
    entries.push(path.join(SRC_DIR, "trust/trusted-write.ts"));
    entries.push(path.join(SRC_DIR, "sdk/core.ts"));
    entries.push(path.join(SRC_DIR, "core-index.ts"));
    entries.push(path.join(SRC_DIR, "compiler-cli.ts"));
    entries.push(path.join(SRC_DIR, "sdk/compiler-composition.ts"));
    entries.push(path.join(SRC_DIR, "local-workflow-host/legacy-composition.ts"));
    entries.push(path.join(SRC_DIR, "local-workflow-host/index.ts"));
    entries.push(path.join(SRC_DIR, "local-workflow-host/shared-contracts.ts"));
    entries.push(...PASSIVE_CONSUMERS.map(file => path.join(SRC_DIR, file)));
    expect(engineEdges(entries)).toEqual([]);
  });

  it("preserves function and error-class identities at existing import paths", () => {
    expect(legacy.readRun).toBe(history.readRun);
    expect(legacy.listRuns).toBe(history.listRuns);
    expect(legacy.resolveRunId).toBe(history.resolveRunId);
    expect(legacy.runExists).toBe(history.runExists);
    expect(LegacyAuthorityError).toBe(WorkflowProcessAuthorityError);
    expect(legacyGrant).toBe(isTrustedWriteGranted);
  });

  it("does not create a private directory, run store, or secret key on reads", async () => {
    expect(await loadRunKey(ctx.root)).toBeNull();
    expect(await history.readRun(ctx.root, "missing-run")).toEqual({ status: "absent" });
    expect(await history.runExists(ctx.root, "missing-run")).toBe(false);
    await history.listRuns(ctx.root);
    await history.resolveRunId(ctx.root, "missing");
    expect(await readdir(ctx.root)).toEqual([]);
  });

  it("forwards status, gate, integrity and definition helpers without wrapping", () => {
    expect(legacyStatus).toEqual(status);
    expect(legacyGates).toEqual(gates);
    expect(legacyIntegrity.loadRunKey).toBe(integrity.loadRunKey);
    expect(legacyIntegrity.runIntegrity).toBe(integrity.runIntegrity);
    expect(legacyIntegrity.integrityMatches).toBe(integrity.integrityMatches);
    expect(lookupWorkflowDef).toBe(definition.lookupWorkflowDef);
    expect(mapStageId).toBe(definition.mapStageId);
    expect(isTerminalStatus).toBe(definition.isTerminalStatus);
  });

  it.each(["healthy", "missing-key", "malformed"])("leaves populated %s history untouched", async (state) => {
    await installWorkflowProfile(ctx.root);
    const run = await startWorkflow(ctx.root, "build", {});
    const privatePath = path.join(ctx.root, ".llmwiki", "workflows");
    if (state === "missing-key") await unlink(path.join(privatePath, ".runkey"));
    if (state === "malformed") await writeFile(path.join(privatePath, "runs", `${run.runId}.json`), "{");
    const before = await snapshot(ctx.root);
    const [row] = await status.workflowStatus(ctx.root, run.runId);
    expect(row.classification).toBe(state === "healthy" ? "current" : "blocked-by-config");
    if (state !== "healthy") expect(row.problem).toBe(state === "missing-key" ? "integrity" : "corrupt");
    expect(await snapshot(ctx.root)).toEqual(before);
  });
});

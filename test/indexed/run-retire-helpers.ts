/**
 * @file test/indexed/run-retire-helpers.ts
 * @description Shared fixtures for the batch run retirement tests. Every
 * process that opens a fixture's stores is a CHILD (`fixtures/runs-child.ts`):
 * a preview reads superseded runs' evidence under a reader lease, so a preview
 * in the test process would be a LIVE reader that makes every apply refuse.
 * The test process only copies projects, saves plans and inspects files.
 *
 * BASES. Each file builds its bases once (the activation and every run store
 * are durable commits, about a second each on the test volume) and copies one
 * to an independent root per case.
 *
 * OWNED CHILDREN. A child that keeps running (a held reader, a paused apply, a
 * live barrier) is started only through {@link withChild}, which releases it
 * (its go file) and awaits that exact child on EVERY exit, killing it after a
 * bounded wait, so a failed assertion never leaks a live process into a later
 * case or its evidence.
 */

import { cp, lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect } from "bun:test";
import { afterAll, beforeAll } from "../config/storage-profile-hooks.js";
import type { RunRetirePlanV1, RunRetirePreviewV1 } from "../../src/indexed/run-retire.js";
import { bundleChild, childEnd, runChild, startChild, type ChildEnd } from "../helpers-child-process.js";
import { writePlanBeside } from "./plan-file.js";

/** A base build (activation plus several durable run commits) on the test volume. */
const BASE_BUILD_TIMEOUT_MS = 600_000;
/** A case: a copy, one to three children, each a few durable commits. */
export const CASE_TIMEOUT_MS = 180_000;

/** The bundled child script, once per test file. */
let script: string | undefined;

/** The bundled retirement child. */
export async function runsChild(): Promise<string> {
  script ??= await bundleChild("test/indexed/fixtures/runs-child.ts");
  return script;
}

/** Run one child mode and return its JSON line. */
export async function runsMode(...args: string[]): Promise<Record<string, unknown>> {
  const end = await runChild(await runsChild(), args);
  expect(end.json, end.stderr).not.toBeNull();
  return end.json!;
}

/** Run one child mode that must succeed and return its result. */
export async function ok<T = Record<string, unknown>>(...args: string[]): Promise<T> {
  const json = await runsMode(...args);
  expect(json.outcome, String(json.message)).toBe("ok");
  return json.result as T;
}

/** How long a released child may take to end before it is killed. */
const CHILD_SETTLE_MS = 30_000;

/**
 * Run `body` with a child that keeps running until `go` exists; on every exit
 * of `body` the go file is written and that exact child awaited (SIGKILL after
 * {@link CHILD_SETTLE_MS}). `body` receives the child's eventual end.
 */
export async function withChild<T>(args: readonly string[], go: string, body: (end: Promise<ChildEnd>) => Promise<T>): Promise<T> {
  const child = startChild(await runsChild(), args);
  const end = childEnd(child);
  try {
    return await body(end);
  } finally {
    await writeFile(go, "go").catch(() => undefined);
    const settled = await Promise.race([end, sleep(CHILD_SETTLE_MS).then(() => null)]);
    if (settled === null) { child.kill("SIGKILL"); await end; }
  }
}

/** One scratch run of a base: its phase and its publication evidence. */
export type RunSpec = readonly [phase: "done" | "superseded" | "active", evidence: "none" | "pi" | "pi-raw" | "ih"];

/** A built project and the ids of its named runs. */
export interface RunsProject { readonly root: string; readonly ids: Readonly<Record<string, string>> }

/** Roots this file created, removed by {@link removeRoots}. */
const created: string[] = [];

/** A new temporary root, removed by {@link removeRoots}. */
export async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  created.push(root);
  return root;
}

/**
 * Build a base: an activated project with the compile state, then each named
 * run in order (so their start times are ordered), then `lastRun` bound to the
 * run named `lastRun` (the fixture shortcut for a committing compile), if any.
 */
async function buildBase(runs: Readonly<Record<string, RunSpec>>, lastRun?: string): Promise<RunsProject> {
  const root = await tempRoot("llmwiki-retire-base-");
  await ok("build", root);
  const ids: Record<string, string> = {};
  for (const [name, [phase, evidence]] of Object.entries(runs)) ids[name] = (await ok<{ runId: string }>("run", root, phase, evidence)).runId;
  if (lastRun !== undefined) await ok("last-run", root, ids[lastRun]!);
  return { root, ids };
}

/** An independent copy of `base`. */
export async function copyOf(base: RunsProject, prefix = "llmwiki-retire-"): Promise<RunsProject> {
  const root = await tempRoot(prefix);
  await cp(base.root, root, { recursive: true, verbatimSymlinks: true });
  return { root, ids: base.ids };
}

/** Remove every root this file created (call from `afterAll`). */
export async function removeRoots(): Promise<void> {
  for (const root of created.splice(0)) await rm(root, { recursive: true, force: true });
}

/** Three finished runs, the middle one the compile state's last run: the base most cases share. */
export const FINISHED_RUNS: Readonly<Record<string, RunSpec>> = { oldDone: ["done", "none"], last: ["done", "none"], newDone: ["done", "none"] };

/**
 * Register this file's base: bundle the child and build `runs` once
 * (`beforeAll`, {@link BASE_BUILD_TIMEOUT_MS}), remove every root afterwards;
 * returns the built base (valid inside the cases).
 */
export function useRunsBase(runs: Readonly<Record<string, RunSpec>>, lastRun?: string): () => RunsProject {
  let base: RunsProject | undefined;
  beforeAll(async () => { await runsChild(); base = await buildBase(runs, lastRun); }, BASE_BUILD_TIMEOUT_MS);
  afterAll(removeRoots);
  return () => base!;
}

/** Preview in a child, save the retirement plan beside the project, and return both. */
export async function savedRunsPlan(root: string, keep?: number): Promise<{ preview: RunRetirePreviewV1; planFile: string }> {
  const preview = await ok<RunRetirePreviewV1>("preview", root, ...(keep === undefined ? [] : [String(keep)]));
  return { preview, planFile: await writePlanBeside(root, preview.plan) };
}

/** Write `plan` (possibly edited or forged) to a new file beside the project. */
export function writePlan(root: string, plan: RunRetirePlanV1 | Record<string, unknown>): Promise<string> {
  return writePlanBeside(root, plan, "plan-edited");
}

/** The class each run (by base name) has in `preview`. */
export function classes(preview: RunRetirePreviewV1, ids: Readonly<Record<string, string>>): Record<string, string> {
  const byId = new Map(preview.runs.map((run) => [run.runId, run.class]));
  return Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, byId.get(id) ?? "absent"]));
}

/** Every entry under the project's indexed, quarantine and barrier paths, with its size and mtime: equal before and after means nothing changed. */
export async function indexedTree(root: string): Promise<string[]> {
  const entries: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const stat = await lstat(path.join(root, rel)).catch(() => null);
    if (stat === null) return;
    entries.push(`${rel} ${stat.isDirectory() ? "dir" : stat.size} ${stat.isDirectory() ? "" : stat.mtimeMs}`);
    if (stat.isDirectory()) for (const name of (await readdir(path.join(root, rel))).sort()) await walk(path.join(rel, name));
  };
  for (const rel of [".llmwiki/indexed", ".llmwiki/indexed-retiring", ".llmwiki/indexed-retire.json", ".llmwiki/indexed-pins"]) await walk(rel);
  return entries;
}

/** Whether the run store of `runId` exists in place. */
export async function storeExists(root: string, runId: string): Promise<boolean> {
  return lstat(path.join(root, ".llmwiki", "indexed", `crun-${runId}`)).then(() => true, () => false);
}

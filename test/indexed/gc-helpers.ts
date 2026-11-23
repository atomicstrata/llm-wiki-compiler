/**
 * @file test/indexed/gc-helpers.ts
 * @description Shared fixtures for collection tests. Every process that opens
 * a fixture's stores is a CHILD (`fixtures/gc-child.ts`): the test process
 * itself only previews (no lease) and inspects files, so its own reader lease
 * never makes an apply refuse. Each file builds one base project per store
 * list and copies it to an independent root per test.
 */

import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect } from "bun:test";
import { previewGc, type GcPreviewV1 } from "../../src/indexed/gc.js";
import { bundleChild, runChild } from "../helpers-child-process.js";
import { writePlanBeside } from "./plan-file.js";

/** The bundled child script, once per test file. */
let script: string | undefined;

/** The bundled collection child. */
export async function gcChild(): Promise<string> {
  script ??= await bundleChild("test/indexed/fixtures/gc-child.ts");
  return script;
}

/** Run one child mode and return its JSON line. */
export async function gcMode(...args: string[]): Promise<Record<string, unknown>> {
  const end = await runChild(await gcChild(), args);
  expect(end.json, end.stderr).not.toBeNull();
  return end.json!;
}

/** Immutable built bases, one per store list, shared by the tests of one file. */
const bases = new Map<string, Promise<string>>();

/** Build one base project in a child (real activation and real compaction). */
async function buildBase(stores: readonly string[]): Promise<string> {
  const base = await mkdtemp(path.join(tmpdir(), "llmwiki-gc-base-"));
  expect((await gcMode("build", base, ...stores)).outcome).toBe("ok");
  return base;
}

/**
 * A fresh activated project whose `gcfix` store (or each of `stores`) left
 * superseded segments: an independent copy of this file's base, so each test
 * owns its root while the nine durable commits are paid once per file.
 */
export async function builtProject(prefix: string, ...stores: string[]): Promise<string> {
  const key = stores.join(",");
  let base = bases.get(key);
  if (base === undefined) { base = buildBase(stores); bases.set(key, base); }
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await cp(await base, root, { recursive: true, verbatimSymlinks: true });
  return root;
}

/** Remove this file's bases (call from `afterAll`). */
export async function removeBases(): Promise<void> {
  for (const base of bases.values()) await rm(await base, { recursive: true, force: true });
  bases.clear();
}

/** The leaf names of `store`. */
export function storeLeaves(root: string, store: string): Promise<string[]> {
  return readdir(path.join(root, ".llmwiki", "indexed", store));
}

/** Preview, save the plan, and return both. */
export async function savedPlan(root: string): Promise<{ preview: GcPreviewV1; planFile: string }> {
  const preview = await previewGc(root);
  return { preview, planFile: await writePlanBeside(root, preview.plan) };
}

/** One store's preview entry. */
export function storePreview(preview: GcPreviewV1, store: string): GcPreviewV1["stores"][number] {
  const entry = preview.stores.find((item) => item.store === store);
  expect(entry).toBeDefined();
  return entry!;
}

/** How long a test waits for a child's announcement file. */
const WAIT_LIMIT_MS = 300_000;

/** Wait until `file` exists, failing after {@link WAIT_LIMIT_MS}. */
export async function waitFor(file: string): Promise<void> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await sleep(10);
  }
}

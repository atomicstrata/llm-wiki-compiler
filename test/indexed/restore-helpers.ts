/**
 * @file test/indexed/restore-helpers.ts
 * @description Shared fixtures for indexed-authority backup and restore tests.
 * Every process that reads a fixture's stores is a CHILD
 * (`fixtures/restore-child.ts`): a restore must run in a fresh process, and
 * the test process holds no lease of its own on a fixture.
 */

import { existsSync } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "bun:test";
import { bundleChild, runChild } from "../helpers-child-process.js";

let script: string | undefined;
/** Roots and backup directories to remove after each test. */
export const owned: string[] = [];

/** The bundled restore child. */
export async function restoreChild(): Promise<string> {
  script ??= await bundleChild("test/indexed/fixtures/restore-child.ts");
  return script;
}

/** Run one child mode and return its JSON line. */
export async function child(...args: string[]): Promise<Record<string, unknown>> {
  const end = await runChild(await restoreChild(), args);
  expect(end.json, end.stderr).not.toBeNull();
  return end.json!;
}

/** A fresh activated project, removed after the test. */
export async function activated(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-restore-"));
  owned.push(root);
  expect((await child("activate", root)).outcome).toBe("ok");
  return root;
}

/** A backup of `root` in a new directory outside it. */
export async function backedUp(root: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "llmwiki-backup-"));
  owned.push(dir);
  const made = await child("backup", root, dir);
  expect(made.outcome, String(made.message)).toBe("ok");
  return dir;
}

/** Remove every owned root and backup. */
export async function cleanup(): Promise<void> {
  for (const dir of owned.splice(0)) await rm(dir, { recursive: true, force: true });
}

/** The first referenced segment of `store` in `root`, by the manifest. */
export async function firstSegment(root: string, store: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(root, ".llmwiki", "indexed", store, "manifest.json"), "utf8")) as { runs: { segments: { name: string }[] }[] };
  return path.join(root, ".llmwiki", "indexed", store, manifest.runs[0]!.segments[0]!.name);
}

/** Whether the restore marker exists in `root`. */
export const markerPresent = (root: string): boolean => existsSync(path.join(root, ".llmwiki", "indexed-restore.json"));

let custodyScript: string | undefined;

/** The bundled custody child (it builds the fixture projects). */
export async function custodyChild(): Promise<string> {
  custodyScript ??= await bundleChild("test/indexed/fixtures/custody-child.ts");
  return custodyScript;
}

/** A project whose segmented compile state is the authority, built in a child; owned (removed on cleanup). */
export async function compileStateProject(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `llmwiki-${label}-`));
  owned.push(root);
  const end = await runChild(await custodyChild(), ["cstate", root]);
  expect(end.json?.outcome, end.stderr).toBe("ok");
  return root;
}

/** Flip one byte of `file` in place. */
export async function corruptByte(file: string): Promise<void> {
  const handle = await open(file, "r+");
  await handle.write(Buffer.from("Z"), 0, 1, 24);
  await handle.close();
}

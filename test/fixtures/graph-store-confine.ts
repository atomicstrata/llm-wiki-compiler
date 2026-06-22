/**
 * @file test/fixtures/graph-store-confine.ts
 * @description Shared setup + symlink-planting + assertion helpers for the audit
 * FIX F2/F4/F5 graph-store tests (mandatory-preflight, profile-filter, dir
 * confinement). Centralizes the research-lite root + out-of-tree dir setup, the
 * leaf/dir symlink plants, and the "status surfaces a store problem, omits counts"
 * assertion so the per-fix test files do not re-derive that boilerplate.
 */

import { mkdtemp, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { EVENTS_FILE, RELATIONS_FILE, WIKI_GRAPH_DIR } from "../../src/utils/constants.js";
import type { ProfileSummaryBlock } from "../../src/profile/block.js";
import { buildResearchLiteRelationsProject } from "./profile-fixtures.js";

/** A research-lite root plus a paired out-of-tree directory, with teardown. */
export interface ConfineRoots {
  root: string;
  outside: string;
}

/**
 * Make a fresh research-lite relations project root + a sibling out-of-tree dir.
 * Caller is responsible for {@link cleanupConfineRoots} in afterEach.
 */
export async function makeConfineRoots(label: string): Promise<ConfineRoots> {
  const root = await mkdtemp(path.join(tmpdir(), `${label}-`));
  const outside = await mkdtemp(path.join(tmpdir(), `${label}-out-`));
  await buildResearchLiteRelationsProject(root);
  return { root, outside };
}

/** Remove both roots created by {@link makeConfineRoots}. */
export async function cleanupConfineRoots(ctx: Partial<ConfineRoots>): Promise<void> {
  if (ctx.root) await rm(ctx.root, { recursive: true, force: true });
  if (ctx.outside) await rm(ctx.outside, { recursive: true, force: true });
}

/** Plant `wiki/graph` as a symlink to the out-of-tree dir (DIR-defense escape). */
export async function plantGraphDirSymlink(ctx: ConfineRoots): Promise<void> {
  await mkdir(path.join(ctx.root, "wiki"), { recursive: true });
  await symlink(ctx.outside, path.join(ctx.root, WIKI_GRAPH_DIR));
}

/** Plant a store leaf (events or relations) as a symlink to a header-bearing out-of-tree file. */
export async function plantLeafSymlink(ctx: ConfineRoots, store: "events" | "relations"): Promise<void> {
  await mkdir(path.join(ctx.root, WIKI_GRAPH_DIR), { recursive: true });
  const kind = store === "events" ? "event-store-header" : "relation-store-header";
  const target = path.join(ctx.outside, `leak-${store}.jsonl`);
  await writeFile(target, `{"kind":"${kind}","schemaVersion":1}\n`, "utf8");
  await symlink(target, path.join(ctx.root, store === "events" ? EVENTS_FILE : RELATIONS_FILE));
}

/** Assert a status profile block surfaced a store problem matching `pattern` AND omitted live counts. */
export function expectStoreProblemNoCounts(profile: ProfileSummaryBlock | undefined, pattern: RegExp): void {
  expect(profile?.problems?.some((p) => pattern.test(p.message))).toBe(true);
  expect("relationCounts" in (profile ?? {})).toBe(false);
}

/**
 * Assert the seeded research-lite `tests` relation appears as a graph edge between
 * its `experiments/ablation-batch-size` → `ideas/sparse-routing` endpoints, tagged
 * `relation`/`tests`. Shared by the typed-graph + profile-filter snapshot tests.
 */
export function expectTestsRelationEdge(edges: unknown[]): void {
  expect(edges).toContainEqual({
    source: "experiments/ablation-batch-size",
    target: "ideas/sparse-routing",
    edgeKind: "relation",
    relationType: "tests",
  });
}

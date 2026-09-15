/** Residual private-file readers must retain their refusal semantics without native no-follow flags. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readStateClassified } from "../src/utils/state.js";
import { readConfinedRaw } from "../src/utils/embeddings-store.js";
import { readPendingMarker } from "../src/utils/pending-embeddings.js";
import { loadProfile } from "../src/profile/load.js";
import { loadBatch } from "../src/trust/journal.js";
import { releaseLock } from "../src/utils/lock.js";
import { openDirectoryNoFollow, resolveDistributionPaths } from "../src/profile/templates/publish/distribution-paths.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, constants: { ...fs.constants, O_NOFOLLOW: undefined, O_NONBLOCK: undefined, O_DIRECTORY: undefined } };
});

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "portable-consumers-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const cases = [
  { name: "state", file: "state.json", body: { version: 1, indexHash: "", sources: {} },
    read: async () => (await readStateClassified(root)).status, good: "ok", rejected: "corrupt" },
  { name: "embedding bytes", file: "embeddings.json", body: {},
    read: () => readConfinedRaw(root), good: "{}", rejected: null },
  { name: "recovery marker", file: "pending-embeddings.json", body: [],
    read: async () => (await readPendingMarker(root)).status, good: "ok", rejected: "unavailable" },
  { name: "profile", file: "profile.json", body: { schemaVersion: 1, profileId: "probe", displayName: "Probe", entities: { notes: { directory: "wiki/notes" } } },
    read: async () => { try { return (await loadProfile(root)).profile.profileId; } catch { return "refused"; } }, good: "probe", rejected: "refused" },
  { name: "journal", file: "journal/probe.json", body: { batchId: "probe", status: "committed", entries: [] },
    read: async () => (await loadBatch(root, "probe"))?.status ?? null, good: "committed", rejected: null },
];

it.each(cases)("$name reads an ordinary file but rejects the same bytes behind a link", async (entry) => {
  const leaf = path.join(root, ".llmwiki", entry.file);
  const outside = path.join(root, "outside.json");
  await mkdir(path.dirname(leaf), { recursive: true });
  await writeFile(leaf, JSON.stringify(entry.body));
  expect(await entry.read()).toBe(entry.good);
  await rename(leaf, outside);
  await symlink(outside, leaf, "file");
  expect(await entry.read()).toBe(entry.rejected);
});

it("refuses directory anchoring explicitly when the required native flags are missing", async () => {
  const attempt = openDirectoryNoFollow(root).then(async (handle) => { await handle.close(); });
  await expect(attempt).rejects.toThrow(/directory anchoring.*not supported/i);
  await expect(resolveDistributionPaths(root)).rejects.toThrow(/directory anchoring.*not supported/i);
});

it("does not release a lock by following a link to this process id", async () => {
  const leaf = path.join(root, ".llmwiki", "lock");
  const outside = path.join(root, "outside-lock");
  await mkdir(path.dirname(leaf), { recursive: true });
  await writeFile(outside, String(process.pid));
  await symlink(outside, leaf, "file");
  await releaseLock(root);
  expect((await lstat(leaf)).isSymbolicLink()).toBe(true);
});

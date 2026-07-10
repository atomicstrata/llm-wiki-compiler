/**
 * @file test/journal-health-surfaces.test.ts
 * @description Cross-surface coverage that a `pending` / `unavailable` journal is
 * SURFACED identically by every content-exposing read surface — so an agent or
 * user is never silently served partial post-crash state. The shared mapper
 * {@link journalHealthWarning} is threaded into each surface's OWN warning
 * channel (mirroring `relation-store-unavailable` / `embedding-index-outdated`):
 *
 *  - status   (`collectStatus`)         → `warnings[]` carries `incomplete-compile` / `journal-unavailable`
 *  - lint     (`lint`)                  → a `journal-health` rule result with that code as its message tag
 *  - viewer   (`buildViewerSnapshot`)   → top-level `warnings[]`
 *  - export   (`exportJson`)            → top-level `warnings[]`
 *  - okf      (`runOkfExport`)          → `warnings: string[]`, formatted `code: message`
 *  - context  (`buildContextPack`)      → top-level `warnings[]`
 *  - SDK list (`listPages`)             → top-level `warnings[]`
 *  - SDK search (`pickSearchRefs`)      → `warnings[]`
 *
 * Every surface is asserted three ways: a PENDING journal → `incomplete-compile`;
 * an UNAVAILABLE (symlink-escaping) journal → `journal-unavailable` (a tamper is
 * never silent / never reported healthy); a clean `ok` journal → NO journal
 * warning (parity-safe). A final test asserts threading stays read-only (no
 * `.llmwiki` materialized on a clean read).
 *
 * RESIDUAL: the other export targets (llms-txt, json-ld, graphml, marp) are
 * string-only renderers with NO structured warning slot; `getPage` / `getSource`
 * (single-record reads) and the bare-slug `pickSearchSlugs` shim carry NO
 * `warnings[]` channel by contract. None can surface the journal warning; the
 * full `search`/`listPages`/`okf`/`json` envelopes do.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, access } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { collectStatus } from "../src/status/collect.js";
import { lint } from "../src/linter/index.js";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import { exportJson } from "../src/commands/export.js";
import { runOkfExport } from "../src/export/okf/run.js";
import { buildContextPack } from "../src/context/build.js";
import { listPages } from "../src/pages/list.js";
import { pickSearchRefs } from "../src/search/retrieval.js";
import {
  INCOMPLETE_COMPILE_CODE,
  JOURNAL_UNAVAILABLE_CODE,
} from "../src/trust/journal-health-warning.js";
import { LLMWIKI_DIR } from "../src/utils/constants.js";
import {
  plantPendingTwoTargetBatch,
  plantSymlinkedJournalDir,
} from "./trust/journal-fixture.js";

let root: string;
let outsideDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "journal-surfaces-"));
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await mkdir(path.join(root, "wiki", "queries"), { recursive: true });
  outsideDir = await mkdtemp(path.join(tmpdir(), "journal-surfaces-outside-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

/** Plant a cleanly-loadable PENDING batch so every surface sees `pending`. */
async function plantPending(): Promise<void> {
  await plantPendingTwoTargetBatch(root, "wiki/concepts", "pending");
}

/** Plant a symlink-escaping journal dir so every surface sees `unavailable`. */
async function plantUnavailable(): Promise<void> {
  await plantSymlinkedJournalDir(root, outsideDir);
}

/** Collect the warning codes a surface exposes; one accessor per surface. */
const surfaceWarningCodes: Record<string, () => Promise<string[]>> = {
  status: async () => ((await collectStatus(root)).warnings ?? []).map((w) => w.code),
  lint: async () =>
    (await lint(root)).results
      .filter((r) => r.rule === "journal-health")
      .map((r) => r.message.split(":")[0]),
  viewer: async () => ((await buildViewerSnapshot(root)).warnings ?? []).map((w) => w.code),
  export: async () => ((await exportJson(root)).warnings ?? []).map((w) => w.code),
  // OKF's `warnings` are `string[]` formatted `code: message`; split to the code.
  // The bundle is written under `outsideDir` so the read-only test's `.llmwiki`
  // assertion against `root` stays valid.
  okf: async () =>
    (await runOkfExport(root, { out: path.join(outsideDir, "okf") })).warnings.map(
      (w) => w.split(":")[0],
    ),
  context: async () =>
    (await buildContextPack({ root, prompt: "x" })).warnings.map((w) => w.code),
  list: async () => ((await listPages(root)).warnings ?? []).map((w) => w.code),
  search: async () => (await pickSearchRefs(root, "x")).warnings.map((w) => w.code),
};

const SURFACES = Object.keys(surfaceWarningCodes);

describe("journal health surfaces — pending → incomplete-compile", () => {
  beforeEach(plantPending);

  for (const surface of SURFACES) {
    it(`${surface} carries incomplete-compile`, async () => {
      const codes = await surfaceWarningCodes[surface]();
      expect(codes).toContain(INCOMPLETE_COMPILE_CODE);
      expect(codes).not.toContain(JOURNAL_UNAVAILABLE_CODE);
    });
  }
});

describe("journal health surfaces — unavailable → journal-unavailable", () => {
  beforeEach(plantUnavailable);

  for (const surface of SURFACES) {
    it(`${surface} carries journal-unavailable (never silent)`, async () => {
      const codes = await surfaceWarningCodes[surface]();
      expect(codes).toContain(JOURNAL_UNAVAILABLE_CODE);
      expect(codes).not.toContain(INCOMPLETE_COMPILE_CODE);
    });
  }
});

describe("journal health surfaces — ok adds nothing (parity-safe)", () => {
  for (const surface of SURFACES) {
    it(`${surface} carries no journal warning on a clean journal`, async () => {
      const codes = await surfaceWarningCodes[surface]();
      expect(codes).not.toContain(INCOMPLETE_COMPILE_CODE);
      expect(codes).not.toContain(JOURNAL_UNAVAILABLE_CODE);
    });
  }
});

describe("journal health surfaces — threading stays read-only", () => {
  it("does not materialize .llmwiki on a clean read across every surface", async () => {
    for (const surface of SURFACES) await surfaceWarningCodes[surface]();
    await expect(access(path.join(root, LLMWIKI_DIR))).rejects.toThrow();
  });

  it("does not replay/prune a pending journal when a surface reads it", async () => {
    await plantPending();
    const journalDir = path.join(root, LLMWIKI_DIR, "journal");
    await collectStatus(root);
    await buildViewerSnapshot(root);
    await exportJson(root);
    // The pending journal file is still present (no replay/prune side effect).
    await expect(access(path.join(journalDir, "pending.json"))).resolves.toBeUndefined();
  });
});

/**
 * RESIDUAL (cannot carry a warning): `getPage`/`getSource` return a single
 * record (`Page | null`) with no envelope, and `pickSearchSlugs` returns a bare
 * `string[]`; neither has a `warnings[]` channel. The journal warning rides the
 * full `listPages`/`search` envelopes instead, which agents use for discovery.
 */
it("residual single-record reads have no warning channel (documented)", async () => {
  await plantPending();
  await writeFile(path.join(root, "wiki", "concepts", "a.md"), "# A\n", "utf-8");
  // getPage returns a bare Page with no warnings[] — asserted structurally.
  const { getPage } = await import("../src/pages/list.js");
  const page = await getPage(root, { pageDirectory: "concepts", slug: "a" });
  expect(page).not.toBeNull();
  expect(page).not.toHaveProperty("warnings");
});

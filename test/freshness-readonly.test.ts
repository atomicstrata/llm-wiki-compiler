/**
 * Read-only regression guard: `collectStatus` and `buildViewerSnapshot` must
 * never trigger a `.bak` write. Since `.bak` is written only by `readState`,
 * its absence under a corrupt state.json proves these surfaces never call it.
 *
 * Why no-bak over vi.spyOn: both surfaces import `readStateClassified`
 * directly via named ESM binding — they never import `readState` — so a spy
 * on the module object would trivially pass even if the invariant broke. The
 * corrupt-state/no-bak check is deterministic and harness-independent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "fs";
import { rm } from "fs/promises";
import path from "path";
import { collectStatus } from "../src/mcp/status.js";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { writeCorruptTestStateJson } from "./fixtures/state-json.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";

let root: string;
const bakPath = () => path.join(root, ".llmwiki/state.json.bak");

beforeEach(async () => {
  root = await makeTempRoot("freshness-readonly");
  await writePage(path.join(root, CONCEPTS_DIR), "topic", { title: "Topic" }, "Body.");
  await writeCorruptTestStateJson(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("read-only surfaces never call readState", () => {
  it("collectStatus writes no .bak on corrupt state.json", async () => {
    await collectStatus(root);
    expect(existsSync(bakPath())).toBe(false);
  });

  it("buildViewerSnapshot writes no .bak on corrupt state.json", async () => {
    await buildViewerSnapshot(root);
    expect(existsSync(bakPath())).toBe(false);
  });
});

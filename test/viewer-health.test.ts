/**
 * Count parity between `/api/health` and MCP `wiki_status`, plus
 * stateStatus surfacing for the corrupt-state banner.
 *
 * The two surfaces serve different envelopes — MCP returns
 * `{ pages: { concepts, queries, total }, sources, pendingCandidates, ... }`,
 * the viewer returns a flat `{ concepts, queries, sources, sourceFiles,
 * pendingReviews, lint }` — but the overlapping count fields MUST agree
 * at startup. MCP reads the filesystem live each call while the viewer
 * freezes counts in its snapshot, so this test asserts parity against
 * the same unchanged fixture; any post-startup mutation that would
 * diverge the two surfaces is intentionally out of scope per
 * spec §V1 Architecture Decision.
 */

import { describe, it, expect } from "vitest";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { writeCorruptTestStateJson, writeSourceState } from "./fixtures/state-json.js";
import {
  useViewerProcessLifecycle,
  type ViewerProcessHandle,
} from "./fixtures/run-cli-server.js";
import { collectPageSummaries } from "../src/compiler/indexgen.js";
import { countCandidates } from "../src/compiler/candidates.js";
import { readState } from "../src/utils/state.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../src/utils/constants.js";

const { start: startViewer } = useViewerProcessLifecycle();

interface ViewerHealth {
  concepts: number;
  queries: number;
  sources: number;
  sourceFiles: number;
  pendingReviews: number;
  stateStatus: "ok" | "missing" | "corrupt";
  lint: unknown;
}

async function fetchHealth(handle: ViewerProcessHandle): Promise<ViewerHealth> {
  const res = await fetch(`http://${handle.host}:${handle.port}/api/health`);
  return (await res.json()) as ViewerHealth;
}

describe("/api/health count parity vs MCP wiki_status helpers", () => {
  it("agrees on concepts, queries, sources, and pendingReviews against unchanged state", async () => {
    const root = await makeTempRoot("viewer-health-parity");
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha" }, "Body.");
    await writePage(path.join(root, "wiki/concepts"), "beta", { title: "Beta" }, "Body.");
    await writePage(path.join(root, "wiki/queries"), "q1", { title: "Q1" }, "Body.");

    const handle = await startViewer(root);
    const health = await fetchHealth(handle);

    // The MCP source helpers consulted by `wiki_status` are the same
    // helpers the viewer snapshot calls. Running them against the same
    // unchanged fixture must produce the same numbers.
    const conceptSummaries = await collectPageSummaries(path.join(root, CONCEPTS_DIR));
    const querySummaries = await collectPageSummaries(path.join(root, QUERIES_DIR));
    const state = await readState(root);
    const pendingCandidates = await countCandidates(root);

    expect(health.concepts).toBe(conceptSummaries.length);
    expect(health.queries).toBe(querySummaries.length);
    expect(health.sources).toBe(Object.keys(state.sources).length);
    expect(health.pendingReviews).toBe(pendingCandidates);
  });

  it("returns lint: null when no lint cache exists", async () => {
    const root = await makeTempRoot("viewer-health-no-lint");
    const handle = await startViewer(root);
    const health = await fetchHealth(handle);
    expect(health.lint).toBeNull();
  });
});

describe("/api/health stateStatus", () => {
  it("returns stateStatus: ok for a project with valid state.json", async () => {
    const root = await makeTempRoot("viewer-health-statestatus-ok");
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha" }, "Body.");
    // Write a minimal valid state.json so readStateClassified returns "ok".
    await writeSourceState(root, {});
    const handle = await startViewer(root);
    const health = await fetchHealth(handle);
    expect(health.stateStatus).toBe("ok");
  });

  it("returns stateStatus: missing for a project with no state.json", async () => {
    const root = await makeTempRoot("viewer-health-statestatus-missing");
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha" }, "Body.");
    // No state.json written — freshness-viewer fixture confirms missing → unverified pages.
    const handle = await startViewer(root);
    const health = await fetchHealth(handle);
    expect(health.stateStatus).toBe("missing");
  });

  it("returns stateStatus: corrupt for a project with corrupt state.json", async () => {
    const root = await makeTempRoot("viewer-health-statestatus-corrupt");
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha" }, "Body.");
    await writeCorruptTestStateJson(root);
    const handle = await startViewer(root);
    const health = await fetchHealth(handle);
    expect(health.stateStatus).toBe("corrupt");
  });
});

/**
 * Dynamic on-request snapshot refresh tests for llmwiki viewer (Issue #272).
 *
 * Verifies:
 *   - Refresh floor clamping, rejection of non-finite intervals, and explicit disable.
 *   - No rebuild happens inside the refresh interval.
 *   - Non-blocking trigger: triggering request gets current snapshot immediately.
 *   - Root pinning: preserves previous snapshot if rebuild returns mismatched root.
 *   - Concurrent requests trigger only one rebuild.
 *   - Resilient fallback when rebuild throws.
 *   - Disposal: no rebuild starts afterwards, one in flight is discarded, and the
 *     wait for it is bounded.
 *   - HTTP integration: startViewerServer is static by default; startViewer refreshes;
 *     close() waits for a rebuild in flight.
 *
 * The HTTP tests fake only `Date`, so an interval elapses without real waiting,
 * and wrap the real snapshot builder in a spy so a test can await the rebuild
 * it triggered instead of sleeping for it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import { setImmediate as nextTick } from "timers/promises";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { startViewer, startViewerServer } from "../src/viewer/server.js";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import {
  ViewerSnapshotManager,
  DEFAULT_REFRESH_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS,
  REBUILD_SHUTDOWN_WAIT_MS,
} from "../src/viewer/snapshot-manager.js";
import type { ViewerSnapshot } from "../src/viewer/types.js";

vi.mock("../src/viewer/snapshot.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/viewer/snapshot.js")>();
  return { ...original, buildViewerSnapshot: vi.fn(original.buildViewerSnapshot) };
});

const builderSpy = vi.mocked(buildViewerSnapshot);

/** Comfortably past the default interval, so a refreshing server would rebuild. */
const PAST_DEFAULT_INTERVAL_MS = DEFAULT_REFRESH_INTERVAL_MS * 12;

/** A promise plus the function that settles it, for holding a rebuild open. */
function deferSnapshot(): { promise: Promise<ViewerSnapshot>; resolve: (snap: ViewerSnapshot) => void } {
  let resolve!: (snap: ViewerSnapshot) => void;
  const promise = new Promise<ViewerSnapshot>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Move the faked wall clock forward without waiting. */
function advanceClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

async function fetchConceptCount(baseUrl: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/pages`);
  const data = (await res.json()) as { counts: { concepts: number } };
  return data.counts.concepts;
}

/** Resolve once the listener refuses connections, i.e. the server has stopped accepting. */
async function waitUntilRefused(baseUrl: string): Promise<void> {
  for (;;) {
    try {
      await fetch(`${baseUrl}/api/pages`);
    } catch {
      return;
    }
    await nextTick();
  }
}

function makeStubSnapshot(root: string, conceptCount: number): ViewerSnapshot {
  return {
    root,
    generatedAt: new Date().toISOString(),
    stateStatus: "ok",
    project: { title: "Test", rootName: "test-root" },
    counts: {
      concepts: conceptCount,
      queries: 0,
      sourceFiles: 0,
      pendingReviews: 0,
      compiledSources: 0,
      stale: 0,
      orphaned: 0,
    },
    index: { available: false, href: "/#/index", body: "", outgoingLinks: [] },
    recentPages: [],
    pages: [],
    sourceFilenames: [],
    graph: { nodes: [], edges: [] },
  };
}

describe("ViewerSnapshotManager unit behavior", () => {
  it("enforces floor, rejects non-finite values, and disables on interval <= 0 or omitted", async () => {
    const snap = makeStubSnapshot("/test/root", 1);
    expect(DEFAULT_REFRESH_INTERVAL_MS).toBe(5_000);
    expect(MIN_REFRESH_INTERVAL_MS).toBe(1_000);

    const builder = vi.fn().mockResolvedValue(makeStubSnapshot("/test/root", 2));
    let currentTime = 100_000;
    const now = () => currentTime;

    // Disabled when refreshIntervalMs is omitted
    const mgrOmitted = new ViewerSnapshotManager(snap, { root: "/test/root", buildSnapshot: builder, now });
    currentTime += 200_000;
    await mgrOmitted.getSnapshot();
    expect(builder).not.toHaveBeenCalled();

    // Disabled when refreshIntervalMs <= 0
    const mgrZero = new ViewerSnapshotManager(snap, { root: "/test/root", refreshIntervalMs: 0, buildSnapshot: builder, now });
    await mgrZero.getSnapshot();
    expect(builder).not.toHaveBeenCalled();

    // Rejects non-finite values
    expect(() => new ViewerSnapshotManager(snap, { refreshIntervalMs: Number.NaN })).toThrow(TypeError);
    expect(() => new ViewerSnapshotManager(snap, { refreshIntervalMs: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it("does not trigger rebuild inside the refresh interval", async () => {
    let currentTime = 100_000;
    const snap = makeStubSnapshot("/test/root", 1);
    const builder = vi.fn().mockResolvedValue(makeStubSnapshot("/test/root", 2));
    const mgr = new ViewerSnapshotManager(snap, {
      root: "/test/root",
      refreshIntervalMs: 1_000,
      buildSnapshot: builder,
      now: () => currentTime,
    });

    currentTime += 500;
    const res = await mgr.getSnapshot();
    expect(builder).not.toHaveBeenCalled();
    expect(res.counts.concepts).toBe(1);
  });

  it("triggers non-blocking background rebuild and returns current snapshot to trigger", async () => {
    let currentTime = 100_000;
    const initialSnap = makeStubSnapshot("/test/root", 1);
    const updatedSnap = makeStubSnapshot("/test/root", 5);

    let resolveRebuild!: (snap: ViewerSnapshot) => void;
    const buildPromise = new Promise<ViewerSnapshot>((resolve) => {
      resolveRebuild = resolve;
    });
    const builder = vi.fn().mockImplementation(() => buildPromise);

    const mgr = new ViewerSnapshotManager(initialSnap, {
      root: "/test/root",
      refreshIntervalMs: 1_000,
      buildSnapshot: builder,
      now: () => currentTime,
    });

    currentTime += 2_000;
    const triggerSnap = await mgr.getSnapshot();
    // Trigger does not stall for the rebuild and receives the current snapshot immediately
    expect(triggerSnap.counts.concepts).toBe(1);
    expect(builder).toHaveBeenCalledTimes(1);

    // Complete the rebuild and yield to let the background handler update state
    resolveRebuild(updatedSnap);
    await buildPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mgr.getCurrentSnapshot().counts.concepts).toBe(5);
  });

  it("pins root and retains previous snapshot when rebuild returns a mismatched root", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let currentTime = 100_000;
    const initialSnap = makeStubSnapshot("/test/root", 1);
    const mismatchedSnap = makeStubSnapshot("/different/root", 99);
    const builder = vi.fn().mockResolvedValue(mismatchedSnap);

    const mgr = new ViewerSnapshotManager(initialSnap, {
      root: "/test/root",
      refreshIntervalMs: 1_000,
      buildSnapshot: builder,
      now: () => currentTime,
    });

    currentTime += 2_000;
    await mgr.getSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(builder).toHaveBeenCalledTimes(1);
    expect(mgr.getCurrentSnapshot().counts.concepts).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("mismatched root"));
    warnSpy.mockRestore();
  });

  it("triggers only one rebuild under concurrent requests; concurrent requests use previous snapshot", async () => {
    let currentTime = 100_000;
    const initialSnap = makeStubSnapshot("/test/root", 1);
    const updatedSnap = makeStubSnapshot("/test/root", 10);

    let resolveRebuild!: (snap: ViewerSnapshot) => void;
    const delayedPromise = new Promise<ViewerSnapshot>((resolve) => {
      resolveRebuild = resolve;
    });
    const builder = vi.fn().mockImplementation(() => delayedPromise);

    const mgr = new ViewerSnapshotManager(initialSnap, {
      root: "/test/root",
      refreshIntervalMs: 1_000,
      buildSnapshot: builder,
      now: () => currentTime,
    });

    currentTime += 2_000;
    const p1 = mgr.getSnapshot();
    const s2 = await mgr.getSnapshot();
    const s3 = await mgr.getSnapshot();

    expect(s2.counts.concepts).toBe(1);
    expect(s3.counts.concepts).toBe(1);
    expect(builder).toHaveBeenCalledTimes(1);

    resolveRebuild(updatedSnap);
    await delayedPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const s1 = await p1;
    expect(s1.counts.concepts).toBe(1);
    expect(mgr.getCurrentSnapshot().counts.concepts).toBe(10);
  });

  it("gracefully falls back to previous snapshot if rebuild throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let currentTime = 100_000;
    const initialSnap = makeStubSnapshot("/test/root", 3);
    const builder = vi.fn().mockRejectedValue(new Error("disk error"));

    const mgr = new ViewerSnapshotManager(initialSnap, {
      root: "/test/root",
      refreshIntervalMs: 1_000,
      buildSnapshot: builder,
      now: () => currentTime,
    });

    currentTime += 2_000;
    const res = await mgr.getSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(builder).toHaveBeenCalledTimes(1);
    expect(res.counts.concepts).toBe(3);
    expect(mgr.getCurrentSnapshot().counts.concepts).toBe(3);
    expect(warnSpy).toHaveBeenCalledWith(
      "viewer snapshot rebuild failed, retaining previous snapshot:",
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it("discards a rebuild that finishes after dispose, and dispose waits for it", async () => {
    let currentTime = 100_000;
    const rebuild = deferSnapshot();
    const mgr = new ViewerSnapshotManager(makeStubSnapshot("/test/root", 1), {
      root: "/test/root",
      refreshIntervalMs: 1_000,
      buildSnapshot: () => rebuild.promise,
      now: () => currentTime,
    });
    currentTime += 2_000;
    await mgr.getSnapshot();

    let isDisposeSettled = false;
    const disposing = mgr.dispose().then(() => {
      isDisposeSettled = true;
    });
    await nextTick();
    expect(isDisposeSettled).toBe(false);

    rebuild.resolve(makeStubSnapshot("/test/root", 7));
    await disposing;
    expect(mgr.getCurrentSnapshot().counts.concepts).toBe(1);
  });

  it("dispose gives up on a rebuild that never settles once the shutdown wait expires", async () => {
    vi.useFakeTimers();
    try {
      let currentTime = 100_000;
      const mgr = new ViewerSnapshotManager(makeStubSnapshot("/test/root", 1), {
        root: "/test/root",
        refreshIntervalMs: 1_000,
        buildSnapshot: () => new Promise<ViewerSnapshot>(() => {}),
        now: () => currentTime,
      });
      currentTime += 2_000;
      await mgr.getSnapshot();

      let isDisposeSettled = false;
      const disposing = mgr.dispose().then(() => {
        isDisposeSettled = true;
      });
      await vi.advanceTimersByTimeAsync(REBUILD_SHUTDOWN_WAIT_MS - 1);
      expect(isDisposeSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await disposing;
      expect(isDisposeSettled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts no rebuild once disposed", async () => {
    let currentTime = 100_000;
    const builder = vi.fn().mockResolvedValue(makeStubSnapshot("/test/root", 2));
    const mgr = new ViewerSnapshotManager(makeStubSnapshot("/test/root", 1), {
      root: "/test/root",
      refreshIntervalMs: 1_000,
      buildSnapshot: builder,
      now: () => currentTime,
    });

    await mgr.dispose();
    currentTime += 2_000;
    const snap = await mgr.getSnapshot();

    expect(builder).not.toHaveBeenCalled();
    expect(snap.counts.concepts).toBe(1);
  });
});

describe("Viewer HTTP server dynamic refresh integration", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    builderSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps snapshot static by default in startViewerServer (opt-in)", async () => {
    const root = await makeTempRoot("viewer-static-server");
    const conceptsDir = path.join(root, "wiki/concepts");
    await writePage(conceptsDir, "page1", { title: "Page 1" }, "Body 1");
    await writePage(conceptsDir, "page2", { title: "Page 2" }, "Body 2");

    // The stub claims one concept while disk holds two, so any rebuild would show.
    const viewer = await startViewerServer(makeStubSnapshot(root, 1), { host: "127.0.0.1", port: 0 });

    try {
      const baseUrl = `http://${viewer.host}:${viewer.port}`;
      advanceClock(PAST_DEFAULT_INTERVAL_MS);

      expect(await fetchConceptCount(baseUrl)).toBe(1);
      // A rebuild starts synchronously inside the request, so none started here.
      expect(builderSpy).not.toHaveBeenCalled();
    } finally {
      await viewer.close();
    }
  });

  it("enables dynamic refresh in startViewer and reflects disk updates after interval", async () => {
    const root = await makeTempRoot("viewer-startviewer-refresh");
    const conceptsDir = path.join(root, "wiki/concepts");
    await writePage(conceptsDir, "first", { title: "First Page" }, "Initial body");
    const viewer = await startViewer({ root, host: "127.0.0.1", port: 0, refreshIntervalMs: 1_000, workflowJourneys: false });

    try {
      const baseUrl = `http://${viewer.host}:${viewer.port}`;
      expect(await fetchConceptCount(baseUrl)).toBe(1);

      await writePage(conceptsDir, "second", { title: "Second Page" }, "Second body");
      advanceClock(2_000);

      // The triggering request is answered from the old snapshot; then wait for its rebuild.
      expect(await fetchConceptCount(baseUrl)).toBe(1);
      expect(builderSpy).toHaveBeenCalledTimes(2);
      await builderSpy.mock.results[1].value;

      expect(await fetchConceptCount(baseUrl)).toBe(2);
      const resPage = await fetch(`${baseUrl}/api/page/concepts/second`);
      expect(resPage.status).toBe(200);
      const pageData = (await resPage.json()) as { title: string; html: string };
      expect(pageData.title).toBe("Second Page");
      expect(pageData.html).toContain("Second body");
    } finally {
      await viewer.close();
    }
  });

  it("close() resolves only after a rebuild in flight has settled", async () => {
    const root = await makeTempRoot("viewer-close-waits");
    await writePage(path.join(root, "wiki/concepts"), "first", { title: "First Page" }, "Initial body");
    const viewer = await startViewer({ root, host: "127.0.0.1", port: 0, refreshIntervalMs: 1_000, workflowJourneys: false });
    const baseUrl = `http://${viewer.host}:${viewer.port}`;
    const rebuild = deferSnapshot();
    builderSpy.mockImplementationOnce(() => rebuild.promise);
    const events: string[] = [];

    advanceClock(2_000);
    await fetchConceptCount(baseUrl);
    const closing = viewer.close().then(() => events.push("closed"));
    await waitUntilRefused(baseUrl);
    await nextTick();
    expect(events).toEqual([]);

    events.push("rebuilt");
    rebuild.resolve(makeStubSnapshot(root, 9));
    await closing;
    expect(events).toEqual(["rebuilt", "closed"]);
  });
});

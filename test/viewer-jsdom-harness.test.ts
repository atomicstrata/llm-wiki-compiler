/**
 * Contract tests for the JSDOM mounting harness itself.
 *
 * The harness rewrites ES-module imports into registry reads because
 * JSDOM's `eval` does not drive module loading. These tests pin that
 * rewrite so adding a new viewer module never silently fails to mount.
 */

import { rm, writeFile } from "fs/promises";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { jsonResponse, mountViewerDom, type FetchResponder } from "./fixtures/viewer-jsdom.js";

const EMPTY_ENVELOPE = {
  project: { title: "demo", rootName: "demo" },
  counts: {},
  pages: [],
  recentPages: [],
  index: { available: false },
};

const responder: FetchResponder = (url) => {
  if (url.endsWith("/api/pages")) return jsonResponse(EMPTY_ENVELOPE);
  if (url.endsWith("/api/health")) return jsonResponse({ lint: null });
  return null;
};

describe("viewer JSDOM harness", () => {
  it("registers every viewer-*.js module in the window registry", async () => {
    const { dom } = await mountViewerDom(responder);
    const registry = (dom.window as unknown as { __viewerModules: Record<string, unknown> })
      .__viewerModules;
    expect(registry["./viewer-search.js"]).toBeTruthy();
    expect(registry["./viewer-sidebar.js"]).toBeTruthy();
    expect(registry["./viewer-rail.js"]).toBeTruthy();
  });

  it("exposes each module's named exports as callable functions", async () => {
    const { dom } = await mountViewerDom(responder);
    const registry = (dom.window as unknown as {
      __viewerModules: Record<string, Record<string, unknown>>;
    }).__viewerModules;
    expect(typeof registry["./viewer-sidebar.js"].renderSidebar).toBe("function");
    expect(typeof registry["./viewer-rail.js"].clearSupportRail).toBe("function");
  });

  it("still renders the shell so existing DOM tests keep working", async () => {
    const { dom } = await mountViewerDom(responder);
    expect(dom.window.document.querySelector("[data-main-pane]")).toBeTruthy();
  });

  it("stubs viewer-graph.js instead of evaluating the real D3-dependent module", async () => {
    const { dom } = await mountViewerDom(responder);
    const registry = (dom.window as unknown as {
      __viewerModules: Record<string, { staleIdsFromEnvelope: (envelope: unknown) => Set<string> }>;
    }).__viewerModules;
    // The real staleIdsFromEnvelope derives ids from page freshness (see
    // viewer-client-graph.test.ts); the harness's stub always returns an
    // empty Set regardless of input. A stale page proving otherwise here
    // would mean the real, D3-dependent module got evaluated instead.
    const envelopeWithStalePage = {
      pages: [{ id: "concepts/x", freshness: { freshnessStatus: "stale" } }],
    };
    const stale = registry["./viewer-graph.js"].staleIdsFromEnvelope(envelopeWithStalePage);
    expect(stale.size).toBe(0);
  });
});

// --- Export-form support ---
//
// The harness must strip every `export` keyword before JSDOM's `eval` sees
// it (there is no module loader). These tests write real, throwaway module
// files into src/viewer/assets/ — the harness discovers modules by
// directory scan, so this is the only way to pin its behaviour against a
// module it did not already know about — and delete them in `afterEach` so
// a failed assertion can never leave a stray file poisoning later runs.
const ASSETS_DIR = path.resolve("src/viewer/assets");
const SUPPORTED_FIXTURE = path.join(ASSETS_DIR, "viewer-export-form-check.js");
const UNSUPPORTED_FIXTURE = path.join(ASSETS_DIR, "viewer-export-default-check.js");

describe("viewer JSDOM harness — export form support", () => {
  afterEach(async () => {
    await rm(SUPPORTED_FIXTURE, { force: true });
    await rm(UNSUPPORTED_FIXTURE, { force: true });
  });

  it("mounts export-const and export-async-function forms with callable exports", async () => {
    await writeFile(
      SUPPORTED_FIXTURE,
      'export async function tempAsyncExport() { return "ok"; }\n' +
        'export const tempConstExport = () => "ok";\n',
      "utf-8",
    );
    const { dom } = await mountViewerDom(responder);
    const registry = (dom.window as unknown as {
      __viewerModules: Record<string, Record<string, unknown>>;
    }).__viewerModules;
    const mod = registry["./viewer-export-form-check.js"];
    expect(typeof mod.tempAsyncExport).toBe("function");
    expect(typeof mod.tempConstExport).toBe("function");
  });

  it("fails loudly, naming the file, for an unsupported export form", async () => {
    await writeFile(UNSUPPORTED_FIXTURE, "export default function tempDefaultExport() {}\n", "utf-8");
    await expect(mountViewerDom(responder)).rejects.toThrow(/viewer-export-default-check\.js/);
  });
});

// --- Multi-line import support ---
//
// IMPORT_PATTERN uses `[\s\S]*?` between the braces specifically so an
// import spanning several lines (one named binding per line, as several
// real viewer-*.js files do) still rewrites into a registry read. This was
// previously verified only by an ad-hoc script, never by a running test.
const MULTILINE_IMPORT_FIXTURE = path.join(ASSETS_DIR, "viewer-multiline-import-check.js");

describe("viewer JSDOM harness — multi-line imports", () => {
  afterEach(async () => {
    await rm(MULTILINE_IMPORT_FIXTURE, { force: true });
  });

  it("rewrites a multi-line import into a registry read", async () => {
    await writeFile(
      MULTILINE_IMPORT_FIXTURE,
      'import {\n  el,\n  heading,\n} from "./viewer-dom.js";\n\n' +
        "export function tempMultilineImportCheck() {\n" +
        '  return typeof el === "function" && typeof heading === "function";\n' +
        "}\n",
      "utf-8",
    );
    const { dom } = await mountViewerDom(responder);
    const registry = (dom.window as unknown as {
      __viewerModules: Record<string, { tempMultilineImportCheck: () => boolean }>;
    }).__viewerModules;
    expect(registry["./viewer-multiline-import-check.js"].tempMultilineImportCheck()).toBe(true);
  });
});

/**
 * Render/sanitize error contract.
 *
 * The spec requires that any render or sanitize failure surface as
 * HTTP 500 with `{ error: { code: "render_failed", message: "Could not
 * render page." } }`, never the raw thrown text. Forcing markdown-it /
 * sanitize-html to throw on a benign input is impractical, so this
 * test uses `vi.mock` to make `renderPageHtml` always throw and then
 * boots the viewer's HTTP server in-process to assert the envelope.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/viewer/render.js", () => ({
  renderPageHtml: () => {
    throw new Error("simulated render failure with details that must not leak");
  },
  // The server only imports `renderPageHtml`; tests that need
  // `buildSanitizerPolicy` import the real module instead of this mock.
}));

import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import { startViewerServer } from "../src/viewer/server.js";

interface ServerHandle {
  host: string;
  port: number;
  close(): Promise<void>;
}

const handles: ServerHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle) await handle.close();
  }
});

async function startServerForFixture(): Promise<{ url: string }> {
  const root = await makeTempRoot("viewer-render-error");
  await writePage(path.join(root, "wiki/concepts"), "x", { title: "X" }, "Body.");
  await writeIndexFile(root);
  const snapshot = await buildViewerSnapshot(root);
  const handle = await startViewerServer(snapshot, { host: "127.0.0.1", port: 0 });
  handles.push(handle);
  return { url: `http://${handle.host}:${handle.port}` };
}

async function writeIndexFile(root: string): Promise<void> {
  const { writeFile } = await import("fs/promises");
  await writeFile(path.join(root, "wiki", "index.md"), "# Index");
}

async function expectRenderFailed(pathname: string): Promise<Response> {
  const { url } = await startServerForFixture();
  const res = await fetch(`${url}${pathname}`);
  expect(res.status).toBe(500);
  const body = (await res.clone().json()) as { error?: { code: string; message: string } };
  expect(body.error?.code).toBe("render_failed");
  expect(body.error?.message).toBe("Could not render page.");
  return res;
}

describe("/api/page renderer failure → spec'd render_failed envelope", () => {
  it("returns 500 with code render_failed and the exact spec'd message", async () => {
    await expectRenderFailed("/api/page/concepts/x");
  });

  it("does not leak the raw thrown error message", async () => {
    const res = await expectRenderFailed("/api/page/concepts/x");
    const text = await res.text();
    expect(text).not.toContain("simulated render failure");
    expect(text).not.toContain("details that must not leak");
  });
});

describe("/api/index renderer failure → spec'd render_failed envelope", () => {
  it("returns 500 with code render_failed for the index route too", async () => {
    await expectRenderFailed("/api/index");
  });
});

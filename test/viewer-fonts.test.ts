/**
 * Self-hosted webfont serving contract.
 *
 * The viewer's CSP pins `font-src 'self'`, so Nebula's typefaces must be
 * served from the asset bundle rather than a CDN. These tests pin the
 * content type, the nested-path handling, and the fact that widening the
 * allowlist did not admit arbitrary binary extensions.
 */

import { describe, expect, it } from "bun:test";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { useViewerProcessLifecycle } from "./fixtures/run-cli-server.js";

const { start: startViewer } = useViewerProcessLifecycle();

/**
 * Start a viewer against an empty temp project and return its base URL.
 * `prefix` is forwarded to `makeTempRoot` to keep each test's temp
 * directory name distinguishable on disk.
 */
async function startBaseUrl(prefix: string): Promise<string> {
  const root = await makeTempRoot(prefix);
  const handle = await startViewer(root);
  return `http://${handle.host}:${handle.port}`;
}

describe("self-hosted webfonts", () => {
  it("serves a Space Grotesk woff2 with the font/woff2 content type", async () => {
    const base = await startBaseUrl("viewer-fonts-space-grotesk");
    const res = await fetch(`${base}/assets/fonts/space-grotesk-latin-500-normal.woff2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
  });

  it("serves a JetBrains Mono woff2", async () => {
    const base = await startBaseUrl("viewer-fonts-jetbrains-mono");
    const res = await fetch(`${base}/assets/fonts/jetbrains-mono-latin-400-normal.woff2`);
    expect(res.status).toBe(200);
  });

  it("still refuses an extension outside the allowlist", async () => {
    const base = await startBaseUrl("viewer-fonts-ttf-reject");
    const res = await fetch(`${base}/assets/fonts/space-grotesk-latin-500-normal.ttf`);
    expect(res.status).toBe(404);
  });
});

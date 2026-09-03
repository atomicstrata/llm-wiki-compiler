/**
 * Asset-packaging contract: `npm pack` must include every viewer asset
 * the runtime server reads from `dist/viewer/assets/`. If a future
 * package.json change drops `dist/` from `files`, or the tsup
 * `onSuccess` hook silently fails to populate the assets directory,
 * the published tarball would ship a viewer that 500s on `GET /`.
 *
 * Uses `npm pack --dry-run --json` so the test inspects the file list
 * without writing a tarball into the working tree.
 */

import { describe, it, expect } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

const REQUIRED_ASSETS = [
  "dist/viewer/assets/index.html",
  "dist/viewer/assets/viewer-content.css",
  "dist/viewer/assets/viewer.js",
  "dist/viewer/assets/viewer-dom.js",
  "dist/viewer/assets/viewer-format.js",
  "dist/viewer/assets/viewer-header.js",
  "dist/viewer/assets/viewer-search.js",
  "dist/viewer/assets/viewer-sidebar.js",
  "dist/viewer/assets/viewer-rail.js",
  "dist/viewer/assets/viewer-lists.js",
  "dist/viewer/assets/viewer-reviews.js",
  "dist/viewer/assets/viewer-workflows.js",
  "dist/viewer/assets/viewer-graph.js",
  "dist/viewer/assets/d3.min.js",
  "dist/viewer/assets/THIRD_PARTY_NOTICES.txt",
  "dist/viewer/assets/llmwiki-logo-64.png",
  "dist/viewer/assets/fonts/space-grotesk-latin-400-normal.woff2",
  "dist/viewer/assets/fonts/space-grotesk-latin-500-normal.woff2",
  "dist/viewer/assets/fonts/space-grotesk-latin-600-normal.woff2",
  "dist/viewer/assets/fonts/space-grotesk-latin-700-normal.woff2",
  "dist/viewer/assets/fonts/jetbrains-mono-latin-400-normal.woff2",
  "dist/viewer/assets/fonts/jetbrains-mono-latin-500-normal.woff2",
  "dist/viewer/assets/fonts/jetbrains-mono-latin-600-normal.woff2",
  "dist/viewer/assets/viewer-tokens.css",
  "dist/viewer/assets/viewer-chrome.css",
  "dist/viewer/assets/viewer-theme-boot.js",
  "dist/viewer/assets/viewer-theme.js",
  "dist/viewer/assets/viewer-dashboard.css",
  "dist/viewer/assets/viewer-dashboard.js",
  "dist/viewer/assets/viewer-pattern.js",
  "dist/viewer/assets/viewer-stat-card.js",
  "dist/viewer/assets/viewer-health.js",
  "dist/viewer/assets/viewer-health-lint.js",
  "dist/viewer/assets/viewer-health.css",
  "dist/viewer/assets/viewer-pipeline.js",
  "dist/viewer/assets/viewer-pipeline-model.js",
  "dist/viewer/assets/viewer-pipeline.css",
  "dist/viewer/assets/viewer-graph.css",
  // Imported by viewer-rail.js. A page route fails to render without them, and
  // the failure would be a bare import 404 in the browser console rather than
  // anything the server reports — which is why they are guarded here.
  "dist/viewer/assets/viewer-entity-fields.js",
  "dist/viewer/assets/viewer-field-format.js",
];

interface PackEntry {
  path: string;
}
interface PackReport {
  files: PackEntry[];
}

describe("npm pack — viewer asset inclusion", () => {
  it("ships every dist/viewer/assets/* file the server reads at runtime", async () => {
    const { stdout } = await exec("npm", ["pack", "--dry-run", "--json"], {
      cwd: process.cwd(),
      maxBuffer: 4 * 1024 * 1024,
    });
    const reports = JSON.parse(stdout) as PackReport[];
    expect(reports.length).toBeGreaterThan(0);
    const files = new Set(reports[0].files.map((f) => f.path));
    for (const asset of REQUIRED_ASSETS) {
      expect(files.has(asset), `expected pack to include ${asset}`).toBe(true);
    }
  });
});

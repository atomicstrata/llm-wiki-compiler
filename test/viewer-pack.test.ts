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
  "dist/viewer/assets/viewer.css",
  "dist/viewer/assets/viewer.js",
  "dist/viewer/assets/viewer-search.js",
  "dist/viewer/assets/viewer-sidebar.js",
  "dist/viewer/assets/viewer-rail.js",
  "dist/viewer/assets/viewer-graph.js",
  "dist/viewer/assets/d3.min.js",
  "dist/viewer/assets/THIRD_PARTY_NOTICES.txt",
  "dist/viewer/assets/llmwiki-logo-64.png",
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

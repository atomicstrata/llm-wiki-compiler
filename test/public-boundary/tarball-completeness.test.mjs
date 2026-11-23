/**
 * @file test/public-boundary/tarball-completeness.test.mjs
 * @description DRAFT v2 from the package-local-pilot track; NOT executed. Lands
 * with D6-artifact-tarball-completeness-v2.patch.
 *
 * Witnesses that the release gate's artifact check now REFUSES a tarball that
 * omits a file the release identity records. Before the patch, `tarballFindings`
 * only reported extra or changed tarball files, so a staged payload file that
 * `npm pack` left out passed. The cases cover: a complete tarball, an omitted
 * payload file, the one accepted omission (an exact path the tarball's own
 * manifest negates in `files`), and a glob negation, which fails closed instead
 * of guessing what it omits. Pure data: no pack, no tarball, no filesystem.
 * This is gate behaviour, not evidence about any current stage (none exists).
 */

import { describe, expect, it } from "bun:test";
import { tarballCompletenessFindings } from "../../scripts/public-boundary/artifact.mjs";

/** A package identity's `path → sha256` map; the hashes are placeholders, only the paths matter here. */
const IDENTITY = { "package.json": "a", "dist/index.js": "b", "dist/index.js.map": "c", "dist/viewer/assets/index.html": "d" };
/** The staged manifest as the baseline ships it: one exact negation. */
const MANIFEST = { name: "pkg", files: ["dist", "!dist/tsconfig.json"] };

describe("tarball completeness against the release identity", () => {
  it("passes a tarball that carries every identity file", () => {
    expect(tarballCompletenessFindings(IDENTITY, Object.keys(IDENTITY), MANIFEST)).toEqual([]);
  });

  it("reports an identity payload file the tarball omits", () => {
    const tarball = Object.keys(IDENTITY).filter((file) => file !== "dist/viewer/assets/index.html");
    expect(tarballCompletenessFindings(IDENTITY, tarball, MANIFEST))
      .toEqual([{ kind: "identity-file-missing-from-tarball", file: "dist/viewer/assets/index.html" }]);
  });

  it("accepts only an omission the manifest negates by exact path", () => {
    const identity = { ...IDENTITY, "dist/tsconfig.json": "e" };
    expect(tarballCompletenessFindings(identity, Object.keys(IDENTITY), MANIFEST)).toEqual([]);
    const other = { ...IDENTITY, "dist/other.json": "f" };
    expect(tarballCompletenessFindings(other, Object.keys(IDENTITY), MANIFEST))
      .toEqual([{ kind: "identity-file-missing-from-tarball", file: "dist/other.json" }]);
  });

  it("refuses a glob negation instead of guessing which files it omits", () => {
    const manifest = { ...MANIFEST, files: ["dist", "!dist/**/*.map"] };
    const tarball = Object.keys(IDENTITY).filter((file) => !file.endsWith(".map"));
    expect(tarballCompletenessFindings(IDENTITY, tarball, manifest)).toEqual([
      { kind: "files-negation-not-an-exact-path", entry: "!dist/**/*.map" },
      { kind: "identity-file-missing-from-tarball", file: "dist/index.js.map" },
    ]);
  });
});

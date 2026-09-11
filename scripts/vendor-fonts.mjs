#!/usr/bin/env node
/**
 * Copy latin-subset woff2 files out of the @fontsource packages into the
 * viewer's asset bundle.
 *
 * The viewer's CSP pins `font-src 'self'`, so the viewer's typefaces cannot load
 * from a CDN. Vendoring through @fontsource (rather than hand-downloading)
 * keeps the operation reproducible and pins the upstream version in
 * package.json. All four families are SIL OFL 1.1; their notices live in
 * src/viewer/assets/THIRD_PARTY_NOTICES.txt.
 *
 * Run via `npm run vendor:fonts` after changing either package version.
 */

import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const target = path.join(projectRoot, "src/viewer/assets/fonts");

/** Families to vendor and the weights used by the built-in themes. */
const FAMILIES = [
  { pkg: "@fontsource/dm-sans", weights: ["400", "500", "700"] },
  { pkg: "@fontsource/nunito", weights: ["700", "800", "900"] },
  { pkg: "@fontsource/space-grotesk", weights: ["400", "500", "600", "700"] },
  { pkg: "@fontsource/jetbrains-mono", weights: ["400", "500", "600"] },
];

await mkdir(target, { recursive: true });

for (const { pkg, weights } of FAMILIES) {
  const dir = path.join(projectRoot, "node_modules", pkg, "files");
  const available = await readdir(dir);
  for (const weight of weights) {
    const suffix = `latin-${weight}-normal.woff2`;
    const match = available.find((name) => name.endsWith(suffix));
    if (!match) {
      throw new Error(`${pkg}: no file ending in ${suffix} (found ${available.length} files)`);
    }
    await cp(path.join(dir, match), path.join(target, match));
    console.log(`fonts: ${match}`);
  }
}

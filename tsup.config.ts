import { defineConfig, type Options } from "tsup";

// Fields shared by both bundles. Extracted into one base object so the CLI and
// library entries can't drift on format/target/output settings.
const shared = {
  format: ["esm"],
  target: "node24",
  outDir: "dist",
  splitting: false,
  sourcemap: true,
} satisfies Options;

export default defineConfig([
  {
    ...shared,
    entry: ["src/cli.ts"],
    // Per-entry targeted clean: only wipe this bundle's own outputs. A blanket
    // `clean: true` here would race the library entry's writes (tsup runs array
    // entries in parallel) and could delete dist/index.* on watch/incremental
    // rebuilds.
    clean: ["dist/cli.js", "dist/cli.js.map"],
    banner: {
      js: "#!/usr/bin/env node",
    },
    // Mirror the viewer's static assets (shell template, stylesheet, client
    // script) into dist/viewer/assets/ so they ship with the published
    // npm package. The Slice 3 viewer server reads the template at runtime
    // and serves /assets/* from this directory.
    onSuccess: "node scripts/copy-viewer-assets.mjs",
  },
  {
    ...shared,
    entry: ["src/index.ts"],
    // Per-entry targeted clean: only this bundle's own outputs, never the CLI's.
    clean: ["dist/index.js", "dist/index.js.map", "dist/index.d.ts"],
    dts: true,
    // No banner — library bundle must not include a shebang line.
  },
]);

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node24",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // Mirror the viewer's static assets (shell template, stylesheet, client
  // script) into dist/viewer/assets/ so they ship with the published
  // npm package. The Slice 3 viewer server reads the template at runtime
  // and serves /assets/* from this directory.
  onSuccess: "node scripts/copy-viewer-assets.mjs",
});

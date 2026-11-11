/**
 * Build the standard distribution as a facade over one core and engine package.
 * Dependency builds finish first; both CLI and SDK externalize the same entries.
 */
import { execFileSync } from "node:child_process";
import { defineConfig, type Options } from "tsup";
import { buildCompilerDependencies, isolateFromSourcePaths } from "./scripts/tsup-command.js";

// Fields shared by both bundles. Extracted into one base object so the CLI and
// library entries can't drift on format/target/output settings.
const shared = {
  format: ["esm"],
  target: "node24",
  outDir: "dist",
  splitting: false,
  sourcemap: true,
  external: ["@atomicstrata/llmwiki-core", "@atomicstrata/llmwiki-core/*", "@atomicstrata/llmwiki-local-workflows"],
} satisfies Options;

export default defineConfig(async (options) => {
  await buildCompilerDependencies(process.cwd());
  let initialBuild = true;
  return [
  {
    ...shared,
    entry: ["src/cli.ts"],
    // The CLI imports a command's module when that command runs. Without
    // splitting, esbuild inlines every command and its imports into cli.js.
    splitting: true,
    esbuildOptions(options) { options.chunkNames = "cli-chunks/[name]-[hash]"; },
    // External packages are outside esbuild's import graph. Watch their source
    // explicitly and rebuild them before announcing a successful facade build.
    ...(options.watch ? {
      watch: ["src", "scripts", "packages/*/package.json", "packages/*/tsup.config.ts", "tsconfig.json"],
      esbuildPlugins: [{
        name: "rebuild-compiler-dependencies",
        setup(build) {
          build.onStart(async () => {
            if (initialBuild) { initialBuild = false; return; }
            await buildCompilerDependencies(process.cwd());
          });
        },
      }],
    } : {}),
    // Per-entry targeted clean: only wipe this bundle's own outputs. A blanket
    // `clean: true` here would race the library entry's writes (tsup runs array
    // entries in parallel) and could delete dist/index.* on watch/incremental
    // rebuilds.
    clean: ["dist/cli.js", "dist/cli.js.map"],
    // `--no-env-file`: Bun would otherwise load the working directory's `.env`
    // before any llmwiki code runs, defeating src/cli/environment.ts, which
    // must keep project credentials out when codex-agent is selected.
    banner: {
      js: "#!/usr/bin/env -S bun --no-env-file",
    },
    // Mirror the viewer's static assets (shell template, stylesheet, client
    // script) into dist/viewer/assets/ so they ship with the published
    // npm package. The Slice 3 viewer server reads the template at runtime
    // and serves /assets/* from this directory. Then shield dist/ from the
    // repository's tsconfig `paths` (see isolateFromSourcePaths).
    onSuccess: async () => {
      execFileSync(process.execPath, ["scripts/copy-viewer-assets.mjs"], { stdio: "inherit" });
      isolateFromSourcePaths("dist");
    },
  },
  {
    ...shared,
    entry: ["src/index.ts"],
    // Per-entry targeted clean: only this bundle's own outputs, never the CLI's.
    clean: ["dist/index.js", "dist/index.js.map", "dist/index.d.ts"],
    dts: true,
    // No banner — library bundle must not include a shebang line.
  },
  ];
});

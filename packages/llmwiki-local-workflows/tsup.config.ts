/**
 * Build the optional engine without embedding core. The matching peer supplies
 * contracts and error identities; the facade supplies the constructed host.
 */
import { defineConfig } from "tsup";
import path from "node:path";

export default defineConfig({
  entry: { index: "../../src/local-workflows/index.ts" },
  outDir: "dist",
  format: ["esm"],
  target: "node24",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: { compilerOptions: {
    rootDir: path.resolve("../../src"),
    paths: { "@atomicstrata/llmwiki-core/local-workflow-contracts": [path.resolve("../../src/local-workflow-host/shared-contracts.ts")] },
  } },
  tsconfig: "../../tsconfig.json",
  external: ["@atomicstrata/llmwiki-core", "@atomicstrata/llmwiki-core/local-workflow-contracts"],
});

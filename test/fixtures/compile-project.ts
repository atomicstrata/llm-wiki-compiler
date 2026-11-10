/**
 * Shared helpers for compile-path tests that stub the AnthropicProvider and
 * exercise compileAndReport() against a minimal on-disk project structure.
 *
 * Provides environment setup/teardown hooks and a factory for temporary project
 * roots so individual test files don't duplicate the boilerplate.
 */

import { mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import os from "os";
import { beforeEach, afterEach, vi } from "bun:test";

/** Options controlling which source file is seeded in the project root. */
export interface CompileProjectOptions {
  /** Directory name suffix embedded in the temp path for easier debugging. */
  dirSuffix: string;
  /** Source file name (relative to sources/). Default: "sample.md". */
  sourceFile?: string;
  /** Content written to the source file. */
  sourceContent?: string;
}

const DEFAULT_SOURCE_FILE = "sample.md";
const DEFAULT_SOURCE_CONTENT = "# Sample\n\nSome source content about a topic.";

/**
 * Build a minimal project root containing sources/, wiki/concepts/, and .llmwiki/.
 * Seeds one source file so the compiler has something to process.
 * @param opts - Configuration for the project root.
 * @returns Absolute path to the created temporary root.
 */
export async function makeCompileProjectRoot(opts: CompileProjectOptions): Promise<string> {
  const root = path.join(
    os.tmpdir(),
    `llmwiki-compile-${opts.dirSuffix}-${Date.now()}`,
  );
  await mkdir(path.join(root, "sources"), { recursive: true });
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(
    path.join(root, "sources", opts.sourceFile ?? DEFAULT_SOURCE_FILE),
    opts.sourceContent ?? DEFAULT_SOURCE_CONTENT,
    "utf-8",
  );
  return root;
}

/**
 * Context object populated by `useCompileProject`. Exposes the current
 * temporary root path so tests can reference it without calling a function.
 */
export interface CompileProjectCtx {
  /** Absolute path to the current test's temporary project root. */
  dir: string;
}

/**
 * Composable that registers beforeEach/afterEach hooks for compile-path tests.
 * Sets LLMWIKI_PROVIDER and ANTHROPIC_API_KEY env vars for each test and cleans
 * up the temporary root and vi mocks afterwards.
 *
 * @param opts - Project root configuration passed to makeCompileProjectRoot.
 * @returns Mutable context with `dir` set by each beforeEach.
 */
export function useCompileProject(opts: CompileProjectOptions): CompileProjectCtx {
  const ctx: CompileProjectCtx = { dir: "" };

  beforeEach(async () => {
    process.env.LLMWIKI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "test-key";
    ctx.dir = await makeCompileProjectRoot(opts);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.LLMWIKI_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    await rm(ctx.dir, { recursive: true, force: true });
  });

  return ctx;
}

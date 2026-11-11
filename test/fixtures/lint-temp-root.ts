/**
 * Shared test helpers for creating a temporary llmwiki layout used by
 * lint-rule tests. Sets up wiki/concepts, wiki/queries, and sources/
 * directories under a unique temp root.
 *
 * Two APIs are provided:
 * - `makeLintTempRoot` — async factory returning a fresh root per call;
 *   callers manage their own beforeEach/afterEach lifecycle.
 * - `useLintTempRoot` — vitest lifecycle helper that wires beforeEach /
 *   afterEach automatically; used by schema-lint tests that prefer the
 *   hook-based style.
 */

import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import os from "os";
import { beforeEach, afterEach } from "bun:test";

/** Common shape returned by makeLintTempRoot — root path and writers. */
export interface LintTempRoot {
  root: string;
  writeConceptPage: (slug: string, content: string) => Promise<void>;
  writeQueryPage: (slug: string, content: string) => Promise<void>;
  writeSourceFile: (name: string, content: string) => Promise<void>;
}

/**
 * Create a temp directory with the standard wiki/sources layout that lint
 * rules expect. Each call returns a fresh isolated path along with helpers
 * for writing concept pages, query pages, and source files.
 * @param prefix - Short label appended to the temp directory name.
 */
export async function makeLintTempRoot(prefix: string): Promise<LintTempRoot> {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await mkdir(path.join(root, "wiki", "queries"), { recursive: true });
  await mkdir(path.join(root, "sources"), { recursive: true });
  return {
    root,
    writeConceptPage: (slug, content) =>
      writeFile(path.join(root, "wiki", "concepts", `${slug}.md`), content),
    writeQueryPage: (slug, content) =>
      writeFile(path.join(root, "wiki", "queries", `${slug}.md`), content),
    writeSourceFile: (name, content) =>
      writeFile(path.join(root, "sources", name), content),
  };
}

// ---------------------------------------------------------------------------
// Hook-based API used by schema-lint tests
// ---------------------------------------------------------------------------

/** Live state populated by `useLintTempRoot` for each test. */
export interface HookLintTempRoot {
  /** Absolute path to the temp project root, valid inside `it` blocks. */
  dir: string;
  /** Write a raw markdown string to wiki/concepts/<slug>.md. */
  writeConcept: (slug: string, content: string) => Promise<void>;
  /** Write a raw markdown string to wiki/queries/<slug>.md. */
  writeQuery: (slug: string, content: string) => Promise<void>;
  /** Write a source markdown file by name. */
  writeSource: (name: string, content: string) => Promise<void>;
}

/**
 * Provision a tmp wiki root and wire vitest before/afterEach hooks so callers
 * just access `env.dir` etc. inside `it` blocks. Eliminates the duplicated
 * lifecycle boilerplate previously copy-pasted across lint test files.
 * @param prefix - Short label for the temp directory name.
 * @returns A live handle whose fields refresh per test.
 */
export function useLintTempRoot(prefix: string): HookLintTempRoot {
  const env: HookLintTempRoot = {
    dir: "",
    writeConcept: notInitialized,
    writeQuery: notInitialized,
    writeSource: notInitialized,
  };

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
    await mkdir(path.join(dir, "wiki", "concepts"), { recursive: true });
    await mkdir(path.join(dir, "wiki", "queries"), { recursive: true });
    await mkdir(path.join(dir, "sources"), { recursive: true });
    env.dir = dir;
    env.writeConcept = (slug, content) =>
      writeFile(path.join(dir, "wiki", "concepts", `${slug}.md`), content);
    env.writeQuery = (slug, content) =>
      writeFile(path.join(dir, "wiki", "queries", `${slug}.md`), content);
    env.writeSource = (name, content) =>
      writeFile(path.join(dir, "sources", name), content);
  });

  afterEach(async () => {
    if (env.dir) await rm(env.dir, { recursive: true, force: true });
  });

  return env;
}

/** Throws if a writer is invoked before vitest has run beforeEach. */
function notInitialized(): Promise<void> {
  throw new Error("LintTempRoot used outside of an it() block");
}

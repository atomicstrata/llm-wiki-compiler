/**
 * @file test/parity-default.test.ts
 * @description Frozen pre-refactor GOLDEN parity baseline for the DEFAULT profile.
 *
 * Phase 0 parity covers the deterministic no-LLM surfaces touched by the
 * profile refactor (read surfaces plus deterministic export output, captured
 * as returned values and written bytes); LLM/embedding surfaces are
 * golden-tested under the seeded-stub harness in a later phase.
 *
 * This file builds the fixed `parity-corpus` once, then captures each
 * deterministic surface (SDK / CLI / MCP / viewer) and snapshots it via
 * `assertGolden`. A coverage gate at the end asserts the captured set equals
 * `DETERMINISTIC_SURFACES` minus anything justifiably deferred. NOTHING in
 * this file touches `src/` — it only reads through public surfaces.
 *
 * Surfaces requiring an LLM / embeddings / provider (search, query,
 * context-pack, eval) are explicitly OUT of scope and are NOT captured here;
 * none of the listed surfaces needed a provider, so `DEFERRED_LLM_SURFACES`
 * is empty.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mkdtemp, rm, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createWiki } from "../src/index.js";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import { buildParityCorpus } from "./fixtures/parity-corpus.js";
import { runCLI } from "./fixtures/run-cli.js";
import { buildServer, callTool, connectMcpClient } from "./fixtures/mcp-test-env.js";
import { assertGolden } from "./parity/golden.js";

/** Every deterministic, no-LLM surface the profile refactor must reproduce. */
const DETERMINISTIC_SURFACES = [
  "sdk.status", "sdk.lint", "sdk.exportJson", "sdk.listPages", "sdk.getPage", "sdk.exportOkf",
  "cli.lint", "cli.export", "cli.next", "cli.review.list",
  "mcp.wiki_status", "mcp.lint_wiki", "mcp.read_page", "mcp.resources",
  "viewer.snapshot",
] as const;

/** Surfaces moved out because they need a provider/are non-deterministic. None did. */
const DEFERRED_LLM_SURFACES: Array<{ surface: string; reason: string }> = [];

/**
 * Truly volatile field names stripped from every snapshot wherever they
 * occur: wall-clock timestamps whose value cannot be pinned. Absolute paths
 * are NOT in this list — they are normalized to `<ROOT>`-relative form by
 * `replaceRoot` so the (load-bearing) relative remainder is still asserted.
 */
const VOLATILE = ["exportedAt", "generatedAt", "at"];

let root = "";
/** Realpath of `root` — macOS resolves temp dirs through the /private symlink. */
let realRoot = "";
const captured = new Set<string>();

/**
 * Every volatile spelling of the temp root that may appear in captured
 * values: the lexical path, its realpath (macOS /private), and the random
 * basename (the viewer surfaces it as `project.title`/`rootName`). Longest
 * first so a full path is tokenized before its own basename substring.
 */
function rootVariants(): string[] {
  const all = [root, realRoot, path.basename(root)].filter(Boolean);
  return [...new Set(all)].sort((a, b) => b.length - a.length);
}

/**
 * Deep-rewrite every string in `value` that mentions the temp `root` so the
 * absolute path becomes the stable token `<ROOT>`. Keeps the informative
 * relative tail of paths like lint `file`, viewer `filePath`, export `path`.
 */
function replaceRoot(value: unknown): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const variant of rootVariants()) out = out.split(variant).join("<ROOT>");
    return out;
  }
  if (Array.isArray(value)) return value.map(replaceRoot);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = replaceRoot(v);
    return out;
  }
  return value;
}

/** Capture a surface value as a golden and record it for the coverage gate. */
function capture(name: string, value: unknown, opts?: Parameters<typeof assertGolden>[2]): void {
  assertGolden(name, replaceRoot(value), opts);
  captured.add(name);
}

/** Replace absolute temp paths and strip ANSI so CLI stdout is byte-stable. */
function normalizeCliText(text: string): string {
  // eslint-disable-next-line no-control-regex
  const noAnsi = text.replace(/\[[0-9;]*m/g, "");
  let out = noAnsi;
  for (const variant of rootVariants()) out = out.split(variant).join("<ROOT>");
  return out;
}

/**
 * Blank the export-time ISO timestamp that several export formats stamp
 * (`exported <ts>`, marp `N pages | <ts>`, the OKF `log.md` date, and the
 * JSON `exportedAt`). The corpus pins all CONTENT timestamps to 2024-01-0x,
 * so any other date is the volatile wall-clock export time and is replaced
 * with `<VOLATILE>` for byte-stability.
 */
function blankExportTime(text: string): string {
  return text
    .replace(/(?!2024-01-0)\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, "<VOLATILE>")
    .replace(/## \d{4}-\d{2}-\d{2}\b/g, "## <DATE>");
}

/** Parse the single JSON envelope a tool handler returns from its text content. */
function parseToolJson(envelope: { content: Array<{ type: string; text: string }> }): unknown {
  const text = envelope.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  return JSON.parse(text);
}

/**
 * Recursively snapshot a written directory tree as `{ relPath: bytes }`,
 * with each file's text normalized (root paths stripped). Volatile JSON
 * fields are handled later by `assertGolden`; here we keep raw text so the
 * produced file SET and per-file bytes are both captured.
 */
async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await walkTree(dir, dir, out);
  return out;
}

/** Recursive worker for {@link snapshotTree}. */
async function walkTree(base: string, dir: string, out: Record<string, string>): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkTree(base, full, out);
    } else {
      const rel = path.relative(base, full).split(path.sep).join("/");
      out[rel] = normalizeCliText(await readFile(full, "utf-8"));
    }
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "parity-default-"));
  realRoot = await realpath(root);
  await buildParityCorpus(root);
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("SDK deterministic surfaces", () => {
  it("captures status, lint, exportJson, listPages, getPage", async () => {
    const wiki = createWiki({ root });
    capture("sdk.status", await wiki.status());
    capture("sdk.lint", await wiki.lint());
    capture("sdk.exportJson", await wiki.exportJson(), { volatile: VOLATILE });
    capture("sdk.listPages", await wiki.listPages({ includeBody: true }), { unordered: ["pages"] });
    capture("sdk.getPage", await wiki.getPage({ pageDirectory: "concepts", slug: "Foo Bar" }));
  });

  it("captures exportOkf returned report plus written bytes", async () => {
    const out = path.join(await mkdtemp(path.join(os.tmpdir(), "parity-okf-")), "okf");
    const wiki = createWiki({ root });
    const report = await wiki.exportOkf({ out });
    // Tokenize the bundle dir: relativize written paths against its realpath
    // (macOS resolves temp dirs through /private, so the report's lexical
    // outDir and the realpath'd written paths diverge) and replace outDir
    // with a stable token. This temp dir is NOT `root`, so replaceRoot misses it.
    const outReal = await realpath(out);
    const relPaths = report.writtenPaths.map((p) => path.relative(outReal, p).split(path.sep).join("/"));
    const tree = await snapshotTree(out);
    // log.md stamps the CURRENT date; blank it (and any export-time stamp).
    for (const file of Object.keys(tree)) tree[file] = blankExportTime(tree[file]);
    capture("sdk.exportOkf", {
      report: { ...report, outDir: "<OUT>", writtenPaths: relPaths },
      tree,
    }, { volatile: VOLATILE, unordered: ["writtenPaths", "warnings"] });
    await rm(path.dirname(out), { recursive: true, force: true });
  });
});

describe("CLI deterministic surfaces", () => {
  it("captures lint, next --json, review list (stdout)", async () => {
    const lint = await runCLI(["lint"], root);
    capture("cli.lint", { code: lint.code, stdout: normalizeCliText(lint.stdout) });
    const next = await runCLI(["next", "--json"], root);
    capture("cli.next", { code: next.code, json: JSON.parse(next.stdout) }, { volatile: VOLATILE });
    const review = await runCLI(["review", "list"], root);
    capture("cli.review.list", { code: review.code, stdout: normalizeCliText(review.stdout) });
  });

  it("captures export stdout plus written file tree and bytes", async () => {
    const result = await runCLI(["export"], root);
    const tree = await snapshotTree(path.join(root, "dist", "exports"));
    // Several formats stamp the volatile export time into their bytes; blank it.
    for (const file of Object.keys(tree)) tree[file] = blankExportTime(tree[file]);
    capture("cli.export", { code: result.code, stdout: normalizeCliText(result.stdout), tree });
  });
});

describe("MCP deterministic surfaces", () => {
  it("captures wiki_status, lint_wiki, read_page (in-process handlers)", async () => {
    const server = buildServer(root);
    capture("mcp.wiki_status", parseToolJson(await callTool(server, "wiki_status", {})));
    capture("mcp.lint_wiki", parseToolJson(await callTool(server, "lint_wiki", {})));
    capture("mcp.read_page", parseToolJson(await callTool(server, "read_page", { slug: "Foo Bar" })));
  });

  it("captures the resource list and a read resource (stdio client)", async () => {
    const { client, transport } = await connectMcpClient(root);
    try {
      const list = await client.listResources();
      const index = await client.readResource({ uri: "llmwiki://index" });
      capture("mcp.resources", {
        resources: list.resources.map((r) => ({ uri: r.uri, name: r.name })),
        index: index.contents.map((c) => ({ uri: c.uri, mimeType: c.mimeType, text: c.text })),
      }, { unordered: ["resources"] });
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});

describe("viewer deterministic surface", () => {
  it("captures the startup snapshot", async () => {
    capture("viewer.snapshot", await buildViewerSnapshot(root), { volatile: VOLATILE });
  });
});

describe("parity coverage gate", () => {
  it("captured every deterministic surface (minus justified deferrals)", () => {
    const deferred = new Set(DEFERRED_LLM_SURFACES.map((d) => d.surface));
    const expected = DETERMINISTIC_SURFACES.filter((s) => !deferred.has(s)).sort();
    expect([...captured].sort()).toEqual(expected);
  });
});

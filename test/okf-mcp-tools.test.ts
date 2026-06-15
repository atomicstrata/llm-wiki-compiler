// test/okf-mcp-tools.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { listCandidates } from "../src/compiler/candidates.js";
import { assertNoOutput } from "./fixtures/no-output.js";
import { collectOkfHandlers } from "./fixtures/okf-tools-harness.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("MCP OKF tools", () => {
  it("export_okf writes a confined bundle; rejects out outside root", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mcp-okf-"));
    await mkdir(path.join(dir, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(dir, "wiki/concepts/rag.md"), "---\ntitle: RAG\nkind: concept\n---\n\nBody.\n");
    const h = collectOkfHandlers(dir);
    await h.get("export_okf")!({ });
    expect((await stat(path.join(dir, "dist/exports/okf/index.md"))).isFile()).toBe(true);
    const bad = await h.get("export_okf")!({ out: "../escape" });
    expect(bad.isError).toBe(true);
  });
  it("import_okf stages (no trusted reachable) and rejects dir outside root", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mcp-okf2-"));
    const b = path.join(dir, "kb"); await mkdir(path.join(b, "concepts"), { recursive: true });
    await writeFile(path.join(b, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
    const h = collectOkfHandlers(dir);
    const res = await h.get("import_okf")!({ dir: "kb" });
    expect(res.isError).toBeUndefined();
    expect(await listCandidates(dir)).toHaveLength(1);
    const bad = await h.get("import_okf")!({ dir: "/etc" });
    expect(bad.isError).toBe(true);
  });
  it("export_okf stays silent even when a cited source is unbundled (stdio-stream safety)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mcp-okf3-"));
    await mkdir(path.join(dir, "wiki/concepts"), { recursive: true });
    // ^[missing.md:1-2] cites a source that does not exist → reportSkippedReferences would print.
    await writeFile(path.join(dir, "wiki/concepts/rag.md"), "---\ntitle: RAG\nkind: concept\n---\n\nClaim. ^[missing.md:1-2]\n");
    const h = collectOkfHandlers(dir);
    const res = await assertNoOutput(() => h.get("export_okf")!({}));
    expect(res.isError).toBeUndefined();
  });
});

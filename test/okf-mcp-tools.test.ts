// test/okf-mcp-tools.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOkfTools } from "../src/mcp/okf-tools.js";
import { listCandidates } from "../src/compiler/candidates.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

/** Capture each registered tool's handler by name. */
function collect(root: string): Map<string, Function> {
  const handlers = new Map<string, Function>();
  const fake = { registerTool: (name: string, _def: unknown, handler: Function) => handlers.set(name, handler) } as unknown as McpServer;
  registerOkfTools(fake, root);
  return handlers;
}

describe("MCP OKF tools", () => {
  it("export_okf writes a confined bundle; rejects out outside root", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mcp-okf-"));
    await mkdir(path.join(dir, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(dir, "wiki/concepts/rag.md"), "---\ntitle: RAG\nkind: concept\n---\n\nBody.\n");
    const h = collect(dir);
    await h.get("export_okf")!({ });
    expect((await stat(path.join(dir, "dist/exports/okf/index.md"))).isFile()).toBe(true);
    const bad = await h.get("export_okf")!({ out: "../escape" });
    expect(bad.isError).toBe(true);
  });
  it("import_okf stages (no trusted reachable) and rejects dir outside root", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mcp-okf2-"));
    const b = path.join(dir, "kb"); await mkdir(path.join(b, "concepts"), { recursive: true });
    await writeFile(path.join(b, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
    const h = collect(dir);
    const res = await h.get("import_okf")!({ dir: "kb" });
    expect(res.isError).toBeUndefined();
    expect(await listCandidates(dir)).toHaveLength(1);
    const bad = await h.get("import_okf")!({ dir: "/etc" });
    expect(bad.isError).toBe(true);
  });
});

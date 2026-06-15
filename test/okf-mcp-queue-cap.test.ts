// test/okf-mcp-queue-cap.test.ts  (≤40 lines)
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { collectOkfHandlers } from "./fixtures/okf-tools-harness.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("import_okf honors the candidate cap", () => {
  it("refuses to stage when the cap would be exceeded, but dry-run is allowed", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mcp-cap-"));
    const b = path.join(dir, "kb"); await mkdir(path.join(b, "concepts"), { recursive: true });
    await writeFile(path.join(b, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
    const handlers = collectOkfHandlers(dir, 0); // injected cap of 0 → any staging is over the cap
    const refused = await handlers.get("import_okf")!({ dir: "kb" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/queue/i);
    const preview = await handlers.get("import_okf")!({ dir: "kb", dryRun: true });
    expect(preview.isError).toBeUndefined(); // dry-run is never blocked
  });
});

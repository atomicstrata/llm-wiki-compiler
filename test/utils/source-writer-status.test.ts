import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveSource } from "../../src/utils/source-writer.js";

const doc = (body: string) => `---\ntitle: Note\nsource: manual:fixed\ningestedAt: ${new Date().toISOString()}\n---\n\n${body}\n`;

describe("saveSource writeStatus", () => {
  it("created → updated → unchanged, and unchanged is a true no-op", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ss-status-"));
    const r1 = await saveSource(root, "Note", doc("alpha"), "manual:fixed");
    expect(r1.writeStatus).toBe("created");

    const r1mtime = (await stat(r1.path)).mtimeMs;
    await new Promise((res) => setTimeout(res, 5));
    const r2 = await saveSource(root, "Note", doc("beta"), "manual:fixed"); // same source, new body
    expect(r2.writeStatus).toBe("updated");
    expect(r2.path).toBe(r1.path);
    expect((await stat(r2.path)).mtimeMs).toBeGreaterThan(r1mtime); // actually rewritten

    const before = await stat(r2.path);
    await new Promise((res) => setTimeout(res, 5));
    const r3 = await saveSource(root, "Note", doc("beta"), "manual:fixed"); // identical body, new ingestedAt
    expect(r3.writeStatus).toBe("unchanged");
    const after = await stat(r3.path);
    expect(after.mtimeMs).toBe(before.mtimeMs); // not rewritten
    expect((await readFile(r3.path, "utf-8"))).toContain("beta");
  });
});

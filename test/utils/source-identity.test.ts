import { describe, it, expect } from "vitest";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveSource } from "../../src/utils/source-writer.js";

// Build a document with an explicit source identity and a given title/body.
const doc = (title: string, body: string, source = "https://x.test/a") =>
  `---\ntitle: ${title}\nsource: ${source}\ningestedAt: ${new Date().toISOString()}\n---\n\n${body}\n`;

describe("saveSource keys on source identity, compares stable content", () => {
  it("same source, changed title → updates the SAME file (no fork)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "src-id-"));
    const r1 = await saveSource(root, "Original Title", doc("Original Title", "body-A", "https://x.test/a"), "https://x.test/a");
    expect(r1.writeStatus).toBe("created");

    const r2 = await saveSource(root, "Renamed Title", doc("Renamed Title", "body-A", "https://x.test/a"), "https://x.test/a");
    expect(r2.writeStatus).toBe("updated"); // same source, body same but title changed → metadata update
    expect(r2.path).toBe(r1.path);          // SAME file reused

    const files = (await readdir(path.join(root, "sources"))).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(1);           // did NOT fork into a second file
    expect(await readFile(r2.path, "utf-8")).toContain("title: Renamed Title"); // metadata updated
  });

  it("identical stable content, fresh ingestedAt → unchanged (no-op)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "src-id2-"));
    const a = await saveSource(root, "T", doc("T", "same body", "https://x.test/b"), "https://x.test/b");
    expect(a.writeStatus).toBe("created");
    const b = await saveSource(root, "T", doc("T", "same body", "https://x.test/b"), "https://x.test/b"); // only ingestedAt differs
    expect(b.writeStatus).toBe("unchanged");
  });

  it("changed body → updated", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "src-id3-"));
    await saveSource(root, "T", doc("T", "v1", "https://x.test/c"), "https://x.test/c");
    const r = await saveSource(root, "T", doc("T", "v2", "https://x.test/c"), "https://x.test/c");
    expect(r.writeStatus).toBe("updated");
  });
});

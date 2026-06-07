import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestSource, ingestTextSource } from "../../src/commands/ingest.js";
import { LOG_FILE } from "../../src/utils/constants.js";

describe("ingestTextSource writeStatus + journaling", () => {
  it("created/updated/unchanged; unchanged writes no journal entry and no rewrite", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ingest-status-"));
    const body = "Enough body content to satisfy the minimum source length requirement.";

    const r1 = await ingestTextSource(root, { title: "N", text: body, source: "manual:fixed" });
    expect(r1.writeStatus).toBe("created");

    const r2 = await ingestTextSource(root, { title: "N", text: body + " more", source: "manual:fixed" });
    expect(r2.writeStatus).toBe("updated");

    const logBefore = await readFile(path.join(root, LOG_FILE), "utf-8");
    const fileBefore = await stat(path.join(root, "sources", r2.filename));
    await new Promise((res) => setTimeout(res, 5));

    const r3 = await ingestTextSource(root, { title: "N", text: body + " more", source: "manual:fixed" });
    expect(r3.writeStatus).toBe("unchanged");
    expect(await readFile(path.join(root, LOG_FILE), "utf-8")).toBe(logBefore); // no new journal line
    expect((await stat(path.join(root, "sources", r3.filename))).mtimeMs).toBe(fileBefore.mtimeMs);
  });

  it("ingestSource: re-ingesting an unchanged file is a no-op (writeStatus + no journal)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ingest-src-status-"));
    const src = path.join(root, "note.md");
    await writeFile(src, "Enough body content to satisfy the minimum source length requirement.", "utf-8");
    const a = await ingestSource(root, src);
    expect(a.writeStatus).toBe("created");
    const logAfterFirst = await readFile(path.join(root, LOG_FILE), "utf-8");
    const b = await ingestSource(root, src);
    expect(b.writeStatus).toBe("unchanged");
    expect(await readFile(path.join(root, LOG_FILE), "utf-8")).toBe(logAfterFirst); // no new entry
  });
});

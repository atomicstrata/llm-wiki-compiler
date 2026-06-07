import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWiki } from "../../src/sdk/wiki.js";

describe("Wiki source API", () => {
  it("ingest → list/get → delete round-trip, with writeStatus, silently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sdk-src-"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const wiki = createWiki({ root });

    const r = await wiki.ingestText({ title: "Note", text: "Some sufficiently long source body content here." });
    expect(r.writeStatus).toBe("created");

    const { sources } = await wiki.listSources();
    expect(sources.map((s) => s.id)).toContain(r.filename);

    const got = await wiki.getSource(r.filename);
    expect(got?.body).toContain("source body");

    expect(await wiki.deleteSource(r.filename)).toBe(true);
    expect(await wiki.getSource(r.filename)).toBeNull();

    expect(logSpy).not.toHaveBeenCalled(); // quiet
    logSpy.mockRestore();
  });
});

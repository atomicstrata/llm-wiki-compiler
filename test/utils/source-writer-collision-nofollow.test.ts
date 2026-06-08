import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveSource } from "../../src/utils/source-writer.js";

/**
 * Collision resolution must use a no-follow existence check: a planted
 * `sources/<slug>.md` symlink must never be read/followed (which would EISDIR on
 * a symlinked directory, or leak an outside file). Ingest picks the hash suffix.
 */
describe("resolveCollisionFreeFilename does not follow a symlinked candidate", () => {
  it("picks the hash suffix instead of reading through sources/<slug>.md", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sw-nofollow-"));
    await mkdir(path.join(root, "sources"), { recursive: true });
    const outsideDir = path.join(root, "outsideDir");
    await mkdir(outsideDir, { recursive: true });
    // sources/safe.md -> an outside DIRECTORY; readFile here would throw EISDIR.
    await symlink(outsideDir, path.join(root, "sources/safe.md"));

    const doc = "---\ntitle: Safe\nsource: newsource\ningestedAt: 2026-01-01T00:00:00.000Z\n---\n\nbody";
    const r = await saveSource(root, "Safe", doc, "newsource"); // must NOT throw EISDIR

    expect(r.writeStatus).toBe("created");
    expect(path.basename(r.path)).not.toBe("safe.md"); // chose the suffix, didn't touch the symlink
    expect(path.basename(r.path)).toMatch(/^safe-[0-9a-f]{8}\.md$/);
    expect(await readdir(outsideDir)).toEqual([]); // nothing written through the symlink target
  });
});

/** Content reads must reject malformed UTF-8 and post-open growth without exporting bytes. */
import { describe, it, expect } from "vitest";
import { writeFile } from "fs/promises";
import path from "path";
import { useTempRoot } from "./fixtures/temp-root.js";
import { openConfinedLeaf, readWithinCapOrElse } from "../src/utils/confined-read.js";

describe("bounded content snapshot", () => {
  const ctx = useTempRoot(["sources"]);
  it("rejects invalid UTF-8 rather than validating substituted bytes", async () => {
    const leaf = path.join(ctx.dir, "sources/a.md");
    await writeFile(leaf, Buffer.from([0xff]));
    const opened = await openConfinedLeaf(ctx.dir, leaf, path.dirname(leaf));
    expect(opened.kind).toBe("confirmed");
    if (opened.kind !== "confirmed") return;
    expect(await readWithinCapOrElse(opened, 10, () => ({ kind: "oversize" }))).toEqual({ kind: "unavailable" });
  });
  it("caps the actual read when a regular file grows after opening", async () => {
    const leaf = path.join(ctx.dir, "sources/a.md");
    await writeFile(leaf, "a");
    const opened = await openConfinedLeaf(ctx.dir, leaf, path.dirname(leaf));
    expect(opened.kind).toBe("confirmed");
    if (opened.kind !== "confirmed") return;
    await writeFile(leaf, "larger than cap");
    expect(await readWithinCapOrElse(opened, 3, () => ({ kind: "oversize" }))).toEqual({ kind: "oversize" });
  });
});

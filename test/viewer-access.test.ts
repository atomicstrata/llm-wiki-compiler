/** Access responses expose only declared metadata and gate bytes independently. */
import { describe, it, expect } from "vitest";
import { writeFile, symlink } from "fs/promises";
import path from "path";
import { useTempRoot } from "./fixtures/temp-root.js";
import { seedArtifact } from "./fixtures/artifact-seed.js";
import { readViewerArtifact } from "../src/viewer/artifact-access.js";
import { readViewerSource } from "../src/viewer/source-access.js";

describe("viewer access projections", () => {
  const ctx = useTempRoot(["sources"]);
  const definitions = { report: { fileName: "report.json", contentKind: "json" as const, maxBytes: 1000,
    metadata: { score: { type: "number" as const, required: true } } } };
  it("projects declared artifact metadata but never returns remote bytes", async () => {
    const ref = await seedArtifact(ctx.dir, "report", "report.json", "a", '{"score":4,"secret":"hidden"}', "json");
    const result = await readViewerArtifact(ctx.dir, definitions, ref, false);
    expect(result).toMatchObject({ health: "ok", metadata: { score: 4 }, contentAccess: "loopback-only" });
    expect(JSON.stringify(result)).not.toContain("hidden");
    expect(result).not.toHaveProperty("body");
    expect(await readViewerArtifact(ctx.dir, definitions, ref, true)).toHaveProperty("body", '{"score":4,"secret":"hidden"}');
  });
  it("rechecks artifact health after modification and drops metadata and bytes", async () => {
    const ref = await seedArtifact(ctx.dir, "report", "report.json", "a", '{"score":4}', "json");
    await writeFile(path.join(ctx.dir, "artifacts/report/a/report.json"), '{"score":5}');
    const result = await readViewerArtifact(ctx.dir, definitions, ref, true);
    expect(result.health).toBe("artifact-bytes-tampered");
    expect(result).not.toHaveProperty("body");
    expect(result).not.toHaveProperty("metadata");
  });
  it("keeps raw source identity distinct and hides local ingestion paths remotely", async () => {
    await writeFile(path.join(ctx.dir, "sources/paper.md"), '---\ntitle: Paper\nsource: /private/secret.pdf\n---\nRaw paper body');
    const result = await readViewerSource(ctx.dir, ["paper.md"], "paper.md", false);
    expect(result).toMatchObject({ kind: "raw-source", title: "Paper", health: "ok" });
    expect(JSON.stringify(result)).not.toContain("/private");
    expect(result).not.toHaveProperty("body");
    const local = await readViewerSource(ctx.dir, ["paper.md"], "paper.md", true);
    expect(String(local.body).split("\n")[4]).toBe("Raw paper body");
  });
  it("rejects a source replaced with a symlink and names absent from the frozen list", async () => {
    await writeFile(path.join(ctx.dir, "secret.md"), "secret");
    await symlink(path.join(ctx.dir, "secret.md"), path.join(ctx.dir, "sources/a.md"));
    expect(await readViewerSource(ctx.dir, ["a.md"], "a.md", true)).toMatchObject({ health: "unavailable" });
    expect(await readViewerSource(ctx.dir, [], "a.md", true)).toMatchObject({ health: "missing" });
    await expect(readViewerSource(ctx.dir, [], "../secret.md", true)).rejects.toThrow();
  });
  it("reports listed non-Markdown sources as unsupported rather than missing", async () => {
    await writeFile(path.join(ctx.dir, "sources/paper.pdf"), "not a supported preview");
    expect(await readViewerSource(ctx.dir, ["paper.pdf"], "paper.pdf", true)).toMatchObject({ health: "unsupported" });
  });
});

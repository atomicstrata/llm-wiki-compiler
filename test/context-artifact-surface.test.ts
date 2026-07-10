/**
 * @file test/context-artifact-surface.test.ts
 * @description The "one surface honest, another silently drops the same
 * failure" regression, for artifact-ref health specifically. When a page's
 * hash-pinned artifactRef no longer verifies (here: a bytes-only tamper —
 * `test/artifacts/artifact-health-surfaces.test.ts` already pins this for
 * lint/status/export), CONTEXT must ALSO surface it as a top-level warning
 * instead of a silent, unhealthy-but-quiet pack — mirroring
 * `test/relation-store-agent-surfaces.test.ts`'s coverage for the relation
 * store. The warning message must carry the health verdict but never the
 * raw artifact body bytes (before or after tampering).
 *
 * Regression: a healthy project (no unresolved artifactRef) gains no such
 * warning, and `test/parity-default.test.ts` pins that an artifact-less
 * project's pack stays byte-identical.
 */
import { describe, it, expect } from "vitest";
import { writeFile } from "fs/promises";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writeProfileFile, writeMarkdownPage } from "./fixtures/profile-fixtures.js";
import { seedArtifact } from "./fixtures/artifact-root.js";
import { artifactPaths } from "../src/artifacts/store.js";
import { formatArtifactRef } from "../src/artifacts/ref.js";
import { buildContextPack } from "../src/context/build.js";
import type { ProfilePack } from "../src/profile/types.js";

/** A profile declaring one artifactRef page field, mirroring `artifact-health-surfaces.test.ts`. */
const PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "context-artifact-health",
  entities: {
    papers: {
      directory: "wiki/papers",
      fields: { title: { type: "string" }, resultRef: { type: "artifactRef", artifactTypes: ["experiment-result"] } },
    },
  },
  artifacts: {
    "experiment-result": {
      fileName: "result.json", contentKind: "json", maxBytes: 65536,
      metadata: { accuracy: { type: "number", required: true } },
    },
  },
};

/** Seed a project with a page referencing a bytes-tampered artifact. */
async function seedTamperedProject(): Promise<{ root: string }> {
  const root = await makeTempRoot("context-artifact-health");
  await writeProfileFile(root, PROFILE);
  const ref = formatArtifactRef(await seedArtifact(root, "experiment-result", "probe", `{"accuracy":0.9}`));
  await writeMarkdownPage(root, "wiki/papers", "p1", `---\ntitle: Paper\nresultRef: ${ref}\n---\n\nBody.\n`);
  const { bytesPath } = artifactPaths(root, "experiment-result", "probe", "result.json");
  await writeFile(bytesPath, `{"accuracy":0.1}`); // bytes-only tamper — manifest left stale
  return { root };
}

describe("broken artifact ref — context surfaces a warning", () => {
  it("emits an artifact-ref-unhealthy warning naming the health verdict, no raw bytes", async () => {
    const { root } = await seedTamperedProject();
    const pack = await buildContextPack({ root, prompt: "anything" });
    const warning = pack.warnings.find((w) => w.code === "artifact-ref-unhealthy");
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("artifact-bytes-tampered");
    expect(warning?.message).not.toContain("0.1");
    expect(warning?.message).not.toContain("0.9");
  });
});

describe("healthy project — no artifact-ref-unhealthy warning", () => {
  it("a project with no unresolved artifactRef emits nothing", async () => {
    const root = await makeTempRoot("context-artifact-health-clean");
    await writeProfileFile(root, PROFILE);
    const ref = formatArtifactRef(await seedArtifact(root, "experiment-result", "probe", `{"accuracy":0.9}`));
    await writeMarkdownPage(root, "wiki/papers", "p1", `---\ntitle: Paper\nresultRef: ${ref}\n---\n\nBody.\n`);
    const pack = await buildContextPack({ root, prompt: "anything" });
    expect(pack.warnings.some((w) => w.code === "artifact-ref-unhealthy")).toBe(false);
  });
});

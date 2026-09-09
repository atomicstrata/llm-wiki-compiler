/** Verified artifact content must come from the same read that establishes health. */
import { describe, it, expect } from "vitest";
import { writeFile } from "fs/promises";
import { useTempRoot } from "../fixtures/temp-root.js";
import { seedArtifact } from "../fixtures/artifact-seed.js";
import { parseArtifactRef } from "../../src/artifacts/ref.js";
import * as resolver from "../../src/artifacts/resolve.js";
import { artifactPaths } from "../../src/artifacts/store.js";
import type { ProfilePack } from "../../src/profile/types.js";

describe("verified artifact content", () => {
  const ctx = useTempRoot();
  const profile: ProfilePack = { schemaVersion: 1, profileId: "test", entities: {},
    artifacts: { report: { fileName: "report.txt", contentKind: "text", maxBytes: 100 } } };
  it("returns verified content without exposing it through the metadata resolver", async () => {
    const ref = parseArtifactRef(await seedArtifact(ctx.dir, "report", "report.txt", "one", "trusted", "text"))!;
    expect(typeof resolver.readVerifiedArtifact).toBe("function");
    const result = await resolver.readVerifiedArtifact(ctx.dir, profile, ref);
    expect(result).toMatchObject({ health: "ok", body: "trusted" });
    expect(await resolver.resolveArtifactRef(ctx.dir, profile, ref)).not.toHaveProperty("body");
    await writeFile(artifactPaths(ctx.dir, "report", "one", "report.txt").bytesPath, "changed");
    expect(result.body).toBe("trusted");
    const changed = await resolver.readVerifiedArtifact(ctx.dir, profile, ref);
    expect(changed.health).toBe("artifact-bytes-tampered");
    expect(changed).not.toHaveProperty("body");
  });
});

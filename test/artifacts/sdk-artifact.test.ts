/**
 * @file test/artifacts/sdk-artifact.test.ts
 * @description Real in-process tests for the SDK `writeArtifact`/`verifyArtifact`
 * methods on the `Wiki` facade returned by `createWiki` — the SDK mirror of the
 * `artifact write`/`artifact verify` CLI commands. Builds a `Wiki` on a
 * research-like root (see `test/fixtures/artifact-root.ts`) and exercises the
 * grant gate, the persisted-ref round trip, the metadata-only `verifyArtifact`
 * return (no body field), and the event-store `origin: "sdk"` provenance —
 * proving `origin` is threaded from the mutation rather than hardcoded downstream.
 *
 * Also proves (at compile time) that the input/return types these two methods
 * name — `SdkWriteArtifactInput`, `ArtifactRef`, `ArtifactHealth` — are part of
 * the public `src/index.ts` surface, not just importable via a deep path.
 */

import { describe, it, afterEach, expect } from "vitest";
import { rm } from "node:fs/promises";
import { createWiki, ArtifactVerifyUnavailableError } from "../../src/index.js";
import type { SdkWriteArtifactInput, ArtifactRef, ArtifactHealth } from "../../src/index.js";
import { makeResearchLikeRoot, makeNonDefaultRootWithNoArtifactTypes } from "../fixtures/artifact-root.js";
import { hashArtifactBody } from "../../src/artifacts/store.js";
import { readEvents } from "../../src/events/store-read.js";

const BODY = `{"accuracy":0.9}`;
// Typed via the public-surface `SdkWriteArtifactInput` — proves the type is
// both exported from `src/index.ts` and structurally matches the real input.
const INPUT: SdkWriteArtifactInput = { artifactType: "experiment-result", slug: "probe", body: BODY };

let root = "";

afterEach(async () => {
  delete process.env.LLMWIKI_TRUSTED_WRITE;
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

/** Read back the sole `artifact-write` event's recorded `origin`, for provenance assertions. */
async function soleArtifactWriteOrigin(writeRoot: string): Promise<string | undefined> {
  const { events } = await readEvents(writeRoot);
  const written = events.filter((e) => e.type === "artifact-write");
  expect(written.length).toBe(1);
  return written[0].origin;
}

describe("SDK writeArtifact/verifyArtifact", () => {
  it("rejects without the grant, advising LLMWIKI_TRUSTED_WRITE, and writes nothing", async () => {
    root = await makeResearchLikeRoot("sdk-artifact-refuse");
    const wiki = createWiki({ root });
    await expect(wiki.writeArtifact(INPUT)).rejects.toThrow(/LLMWIKI_TRUSTED_WRITE/);
  });

  it("applies with the grant, returns the persisted ref, and verifies as healthy", async () => {
    root = await makeResearchLikeRoot("sdk-artifact-write");
    const wiki = createWiki({ root });
    process.env.LLMWIKI_TRUSTED_WRITE = "*";
    // Explicit `ArtifactRef`/`ArtifactHealth` annotations (also public-surface
    // types) prove `writeArtifact`'s/`verifyArtifact`'s real return shapes
    // structurally match what `src/index.ts` exports.
    const { ref }: { ref: ArtifactRef } = await wiki.writeArtifact(INPUT);
    expect(ref).toEqual({ artifactType: "experiment-result", slug: "probe", sha256: hashArtifactBody(BODY) });

    const verified: { health: ArtifactHealth } = await wiki.verifyArtifact(ref);
    expect(verified).toEqual({ health: "ok" });
    expect(Object.keys(verified)).toEqual(["health"]); // metadata/health only — never a body field
  });

  it("records the emitted artifact-write event with origin \"sdk\" (provenance threaded, not hardcoded)", async () => {
    root = await makeResearchLikeRoot("sdk-artifact-origin");
    const wiki = createWiki({ root });
    process.env.LLMWIKI_TRUSTED_WRITE = "*";
    await wiki.writeArtifact(INPUT);

    expect(await soleArtifactWriteOrigin(root)).toBe("sdk");
  });

  it("stamps origin \"sdk\" even when the input tries to inject origin/kind (allowlist-construct, not a trailing spread)", async () => {
    root = await makeResearchLikeRoot("sdk-artifact-spoof");
    const wiki = createWiki({ root });
    process.env.LLMWIKI_TRUSTED_WRITE = "*";
    // A hostile caller (the SDK is a published JS runtime surface, so TS can't
    // stop this) tries to forge the audit-trail origin as "cli" and the kind
    // as "page" by riding along on the input object. Cast through `unknown`
    // to bypass the `SdkWriteArtifactInput` type at the call site.
    const hostile = {
      artifactType: "experiment-result",
      slug: "hostile-probe",
      body: BODY,
      origin: "cli",
      kind: "page",
    } as unknown as SdkWriteArtifactInput;

    const { ref } = await wiki.writeArtifact(hostile);
    expect(ref).toEqual({ artifactType: "experiment-result", slug: "hostile-probe", sha256: hashArtifactBody(BODY) });

    expect(await soleArtifactWriteOrigin(root)).toBe("sdk"); // NOT the injected "cli"
  });

  it("refuses verifyArtifact with a typed error (not a dangling verdict) when the active profile declares no artifact types", async () => {
    root = await makeNonDefaultRootWithNoArtifactTypes("sdk-artifact-no-types");
    const wiki = createWiki({ root });
    const ref = { artifactType: "experiment-result", slug: "probe", sha256: hashArtifactBody(BODY) };

    const rejection = wiki.verifyArtifact(ref);
    await expect(rejection).rejects.toBeInstanceOf(ArtifactVerifyUnavailableError);
    await expect(rejection).rejects.not.toMatchObject({ health: "artifact-dangling" });
    const err = await rejection.catch((e: unknown) => e as Error);
    expect(err.message).not.toMatch(/dangling/);
  });
});

/**
 * @file test/mcp/artifact-verify.test.ts
 * @description Real MCP-over-stdio integration for the read-only `verify_artifact`
 * tool. Spawns the actual `llmwiki serve --root <tmp>` binary, connects an SDK
 * Client via StdioClientTransport, and drives `verify_artifact` through the full
 * JSON-RPC `tools/call` path (no in-process shortcut) — mirroring the `wiki_status`
 * stdio test. Seeds a research-like profile + a written artifact directly on disk
 * (via the shared `test/fixtures/artifact-root.js` helpers) before connecting, so
 * no LLM is needed and the test is fully deterministic.
 *
 * The final `describe` block is a deliberate exception: it drives the tool
 * in-process (`buildServer`/`callTool`, no stdio) to prove the resolve/MCP
 * manifest double-read is gone — see that block's own comment.
 */

import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { connectMcpClient, parseToolPayload, buildServer, callTool } from "../fixtures/mcp-test-env.js";
import { makeResearchLikeRoot, seedArtifact } from "../fixtures/artifact-root.js";
import { loadNonDefaultProfile } from "../../src/profile/block.js";
import { resolveArtifactRef } from "../../src/artifacts/resolve.js";

const BODY = `{"accuracy":0.9}`;

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

/** The expected `verify_artifact` metadata + health payload for the `BODY` fixture artifact, at the given health (default `"ok"`). */
function expectedProbeMetadata(sha256: string, writtenAt: unknown, health: string = "ok"): Record<string, unknown> {
  return {
    artifactType: "experiment-result",
    slug: "probe",
    sha256,
    bytes: Buffer.byteLength(BODY, "utf8"),
    contentKind: "json",
    writtenAt,
    health,
  };
}

/** Absolute path to the on-disk artifact body written by `seedArtifact(root, "experiment-result", "probe", BODY)`. */
function probeBytesPath(root: string): string {
  return path.join(root, "artifacts", "experiment-result", "probe", "result.json");
}

/** Absolute path to that artifact's manifest sidecar. */
function probeManifestPath(root: string): string {
  return path.join(root, "artifacts", "experiment-result", "probe", "result.json.manifest.json");
}

/** Call `verify_artifact` over real stdio and return its decoded JSON payload. */
async function callVerify(root: string, ref: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { client, transport } = await connectMcpClient(root);
  try {
    const result = (await client.callTool({ name: "verify_artifact", arguments: ref })) as CallToolResult;
    return parseToolPayload<Record<string, unknown>>(result);
  } finally {
    await client.close();
    await transport.close();
  }
}

/**
 * Connect a fresh MCP stdio client against `root`, call `verify_artifact` with
 * `ref`, and assert the response carries exactly the probe's metadata + health
 * — and never `excludedText` (the artifact body, or a planted manifest key).
 * Shared by every "clean response" assertion in this file so the
 * connect/close lifecycle and the metadata shape aren't re-spelled per test.
 */
async function expectCleanVerifyResult(
  root: string,
  ref: Record<string, unknown> & { sha256: string },
  excludedText: string,
): Promise<void> {
  const payload = await callVerify(root, ref);
  expect(payload).toEqual(expectedProbeMetadata(ref.sha256, payload.writtenAt));
  expect(JSON.stringify(payload)).not.toContain(excludedText);
}

describe("MCP stdio: verify_artifact", () => {
  it("returns health ok and manifest metadata, never the body", async () => {
    root = await makeResearchLikeRoot("mcp-artifact-verify");
    const ref = await seedArtifact(root, "experiment-result", "probe", BODY);
    await expectCleanVerifyResult(root, ref, "accuracy");
  }, 30_000);

  it("never leaks an unknown key planted in the on-disk manifest sidecar", async () => {
    root = await makeResearchLikeRoot("mcp-artifact-verify-planted-key");
    const ref = await seedArtifact(root, "experiment-result", "probe", BODY);
    const manifestPath = probeManifestPath(root);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.body = "SECRET-LEAK";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await expectCleanVerifyResult(root, ref, "SECRET-LEAK");
  }, 30_000);

  // The three cases below pin the EXACT observable JSON for every manifest-parse
  // outcome (P4.1): a non-ok health that still carries manifest metadata, a
  // non-ok health that carries NONE, and (above/below) the ok case — so the
  // resolve/MCP double-read removal below can't silently change what a caller
  // sees for any of them.

  it("returns artifact-dangling WITH manifest metadata when only the body file is missing", async () => {
    root = await makeResearchLikeRoot("mcp-artifact-verify-dangling-manifest");
    const ref = await seedArtifact(root, "experiment-result", "probe", BODY);
    await rm(probeBytesPath(root)); // manifest sidecar stays — a dangling body under a valid manifest

    const payload = await callVerify(root, ref);
    expect(payload).toEqual(expectedProbeMetadata(ref.sha256, payload.writtenAt, "artifact-dangling"));
  }, 30_000);

  it("returns artifact-bytes-tampered WITH manifest metadata when the on-disk body diverges from the manifest", async () => {
    root = await makeResearchLikeRoot("mcp-artifact-verify-tampered");
    const ref = await seedArtifact(root, "experiment-result", "probe", BODY);
    const tamperedBody = `{"accuracy":0.1}`; // same byte length as BODY, different content → tampered, not oversize
    expect(Buffer.byteLength(tamperedBody, "utf8")).toBe(Buffer.byteLength(BODY, "utf8"));
    await writeFile(probeBytesPath(root), tamperedBody, "utf8");

    const payload = await callVerify(root, ref);
    expect(payload).toEqual(expectedProbeMetadata(ref.sha256, payload.writtenAt, "artifact-bytes-tampered"));
  }, 30_000);

  it("returns artifact-store-unavailable with NO metadata when the manifest is malformed", async () => {
    root = await makeResearchLikeRoot("mcp-artifact-verify-malformed-manifest");
    const ref = await seedArtifact(root, "experiment-result", "probe", BODY);
    await writeFile(probeManifestPath(root), "not json", "utf8"); // never parses → no manifest to carry

    const payload = await callVerify(root, ref);
    expect(payload).toEqual({ health: "artifact-store-unavailable" });
  }, 30_000);

  it("returns artifact-store-unavailable WITH manifest metadata when the manifest's own identity diverges from the ref", async () => {
    root = await makeResearchLikeRoot("mcp-artifact-verify-identity-mismatch");
    const ref = await seedArtifact(root, "experiment-result", "probe", BODY);
    const manifestPath = probeManifestPath(root);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.artifactType = "other-type"; // the manifest itself lies about identity; ref/path still resolve to this file
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    const payload = await callVerify(root, ref);
    // Parity: a non-ok health still surfaces the recorded (co-tamperable) manifest
    // metadata, exactly as the old double-read path did — all 6 fields ride along
    // even though the verdict is store-unavailable.
    expect(payload).toEqual({ ...manifest, health: "artifact-store-unavailable" });
    expect(Object.keys(payload).sort()).toEqual(["artifactType", "bytes", "contentKind", "health", "slug", "sha256", "writtenAt"].sort());
  }, 30_000);

  it("returns artifact-unreadable WITH manifest metadata when the body path is not a regular file", async () => {
    root = await makeResearchLikeRoot("mcp-artifact-verify-unreadable-body");
    const ref = await seedArtifact(root, "experiment-result", "probe", BODY);
    await rm(probeBytesPath(root));
    await mkdir(probeBytesPath(root)); // a directory in place of the body file → body read fails "unavailable", not "absent"

    const payload = await callVerify(root, ref);
    expect(payload).toEqual(expectedProbeMetadata(ref.sha256, payload.writtenAt, "artifact-unreadable"));
  }, 30_000);

  it("rejects a garbage sha256 with a boundary input error, not a health verdict", async () => {
    root = await makeResearchLikeRoot("mcp-artifact-verify-bad-hash");
    const { client, transport } = await connectMcpClient(root);
    try {
      const result = (await client.callTool({
        name: "verify_artifact",
        arguments: { artifactType: "experiment-result", slug: "probe", sha256: "not-a-hash" },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result);
      expect(text).toMatch(/sha256/);
      expect(text).not.toMatch(/artifact-hash-mismatch|artifact-dangling/);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);

  it("registers no write_artifact tool and no store-wide artifact-list tool", async () => {
    root = await makeResearchLikeRoot("mcp-artifact-verify-tool-list");
    const { client, transport } = await connectMcpClient(root);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("verify_artifact");
      expect(names).not.toContain("write_artifact");
      expect(names.some((n) => /list.*artifact|artifact.*list/i.test(n))).toBe(false);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});

// P4.2: prove the manifest double-read is actually gone — not by counting reads
// through the stdio black box (unprovable), but structurally (the second read
// path no longer exists in source) plus an in-process identity check (the
// tool's projected metadata IS `resolveArtifactRef`'s own `manifest` return,
// not a value that merely happens to match).
describe("verify_artifact: single manifest read (structural, P4.2)", () => {
  it("has no second manifest-read path in src/mcp/tools.ts", async () => {
    const src = await readFile(path.resolve("src/mcp/tools.ts"), "utf8");
    expect(src).not.toMatch(/readVerifiedManifestMetadata/);
    expect(src).not.toMatch(/readArtifactManifest/);
  });

  it("returns exactly resolveArtifactRef's own manifest + health (in-process, no stdio JSON round-trip)", async () => {
    root = await makeResearchLikeRoot("mcp-artifact-verify-identity");
    const ref = await seedArtifact(root, "experiment-result", "probe", BODY);

    const loaded = await loadNonDefaultProfile(root);
    if (!loaded) throw new Error("expected a loaded profile in this fixture");
    const resolved = await resolveArtifactRef(root, loaded.profile, ref);

    const server = buildServer(root);
    const envelope = await callTool(server, "verify_artifact", ref);
    expect(envelope.structuredContent?.result).toEqual({ ...resolved.manifest, health: resolved.health });
  });
});

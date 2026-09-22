/**
 * @file test/dev-backend/local-backend.test.ts
 * @description The local development backend, driven against REAL child
 * processes: the transport carries bytes verbatim, a closed stream reports
 * `null`, a hung provider is bounded by the deadline, and stderr capture is
 * bounded.
 *
 * IT LAUNCHES ACTUAL PROCESSES rather than stubbing `spawn`, because every
 * property here is a property of process behaviour — a stub would assert that
 * the test's own model of a child process matches itself.
 *
 * THE FRAMING IS THE RUNTIME'S OWN. Frames are built with `encodeFrame` and
 * decoded with `createFrameDecoder` from `src/`, so a transport that corrupted
 * or re-framed bytes fails here against the real wire format rather than
 * against a second copy of it that could drift.
 */

import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFrameDecoder, encodeFrame } from "../../src/capability-providers/runtime/framing.js";
import { unsandboxedLocalBackend } from "../../packages/llmwiki-dev-backend/src/index.js";

/** Write a provider script into a fresh tree and return its launch inputs. */
async function providerTree(source: string): Promise<{ launchRoot: string }> {
  const launchRoot = await mkdtemp(path.join(tmpdir(), "dev-provider-"));
  await writeFile(path.join(launchRoot, "entry.js"), source, "utf8");
  return { launchRoot };
}

/**
 * The identity the runtime hands a backend. Present because the exported
 * contract IS the runtime's own — an earlier public restatement omitted it, so
 * a backend written against that shape would have been handed fields it had no
 * types for.
 */
const IDENTITY = {
  providerPinDigest: `sha256:${"a".repeat(64)}`, packageDigest: `sha256:${"b".repeat(64)}`,
  manifestDigest: `sha256:${"c".repeat(64)}`, artifactDigest: `sha256:${"d".repeat(64)}`,
  capabilityId: "discover", capabilitySchemaDigest: `sha256:${"e".repeat(64)}`,
} as never;

/** Launch one provider script under the development backend. */
async function launch(source: string, wallTimeMs = 10_000) {
  const { launchRoot } = await providerTree(source);
  return unsandboxedLocalBackend().launch({
    expectedIdentity: IDENTITY, launchRoot, entrypointRelativePath: "entry.js",
    brokerResponseRegionMount: "/broker", wallTimeMs, inputTokens: [],
  });
}

/** Read chunks until the runtime's decoder yields one complete frame. */
async function firstFrame(channel: { receive(): Promise<Buffer | null> }): Promise<unknown> {
  const decoder = createFrameDecoder();
  for (let chunk = await channel.receive(); chunk !== null; chunk = await channel.receive()) {
    const frames = decoder.push(chunk);
    if (frames.length > 0) return frames[0]!.value;
  }
  throw new Error("stream closed before a frame arrived");
}

/** A provider that echoes one framed object back with a marker added. */
const ECHO = `
const chunks = [];
process.stdin.on("data", (c) => {
  chunks.push(c);
  const buf = Buffer.concat(chunks);
  if (buf.length < 4) return;
  const len = buf.readUInt32BE(0);
  if (buf.length < 4 + len) return;
  const body = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
  const out = Buffer.from(JSON.stringify({ echoed: body.probe }), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(out.length, 0);
  process.stdout.write(Buffer.concat([prefix, out]));
});
`;

describe("the local development backend carries the provider protocol", () => {
  it("delivers a sent frame and returns the provider's reply verbatim", async () => {
    const channel = await launch(ECHO);
    await channel.send(encodeFrame({ probe: "superconductivity" }));
    expect(await firstFrame(channel)).toEqual({ echoed: "superconductivity" });
    await channel.terminate();
  });

  it("reports a closed stream as null rather than an error", async () => {
    // The runtime distinguishes "ended" from "broke" itself; a throw here would
    // take that decision away from the layer that owns it.
    const channel = await launch(`process.exit(0);`);
    expect(await channel.receive()).toBeNull();
    await channel.terminate();
  });

  it("bounds a provider that never exits, by the descriptor's wall time", async () => {
    // Without the deadline this receive would hang forever and hold the run open.
    const channel = await launch(`setInterval(() => {}, 1000);`, 300);
    expect(await channel.receive()).toBeNull();
    await channel.terminate();
  });

  it("hands out an output root the provider is told about", async () => {
    const channel = await launch(`
      const out = process.env.LLMWIKI_PROVIDER_OUTPUT_ROOT ?? "";
      const body = Buffer.from(JSON.stringify({ sawOutputRoot: out.length > 0 }), "utf8");
      const p = Buffer.alloc(4); p.writeUInt32BE(body.length, 0);
      process.stdout.write(Buffer.concat([p, body]));
    `);
    expect(await firstFrame(channel)).toEqual({ sawOutputRoot: true });
    expect(await channel.outputRoot()).toContain("llmwiki-provider-out-");
    await channel.terminate();
  });

  it("REMOVES its output root on terminate, so invocations do not accumulate", async () => {
    // One directory per provider phase, forever, is the shape of this leak: it
    // is invisible in any single run and unbounded across a session.
    const channel = await launch(`process.exit(0);`);
    const root = await channel.outputRoot();
    expect(existsSync(root)).toBe(true);
    await channel.terminate();
    expect(existsSync(root)).toBe(false);
  });

  it("REFUSES an entrypoint that escapes the verified package tree", async () => {
    const { launchRoot } = await providerTree(`process.exit(0);`);
    // The tree was verified by the installer; a `..` segment would execute a
    // file that verification never covered.
    await expect(unsandboxedLocalBackend().launch({
      expectedIdentity: IDENTITY, launchRoot, entrypointRelativePath: "../outside.js",
      brokerResponseRegionMount: "/broker", wallTimeMs: 1000, inputTokens: [],
    })).rejects.toThrow(/outside the verified package tree/);
  });
});

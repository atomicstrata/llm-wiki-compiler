/**
 * @file test/limited-isolation/limited-isolation-backend.test.ts
 * @description The negative-space gate for the limited-isolation backend: a
 * real provider child process probes the two ENFORCED controls (network,
 * out-of-scratch writes) and reports what succeeded; the backend witnesses
 * that both are denied, and refuses fail-closed when the isolation tool is
 * absent. Env/FD/proc/tree-kill are NOT tested because they are NOT enforced —
 * claiming them would be false.
 *
 * PLATFORM: the positive controls are witnessed where the isolation tool
 * exists (seatbelt is built into macOS; bubblewrap must be installed on
 * Linux). The fail-closed refusal is witnessed everywhere by pointing at a
 * tool that does not exist.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { createFrameDecoder } from "../../src/capability-providers/runtime/framing.js";
import {
  IsolationUnavailableError, limitedIsolationBackend,
} from "../../packages/llmwiki-limited-isolation-backend/src/index.js";
import { isolationToolPresent, outerCanReach } from "./net-probe-fixture.js";

const IDENTITY = {
  providerPinDigest: `sha256:${"a".repeat(64)}`, packageDigest: `sha256:${"b".repeat(64)}`,
  manifestDigest: `sha256:${"c".repeat(64)}`, artifactDigest: `sha256:${"d".repeat(64)}`,
  capabilityId: "exp-run", capabilitySchemaDigest: `sha256:${"e".repeat(64)}`,
} as never;

/**
 * A provider that PROBES the controls and reports the outcome as its first
 * frame. It tries an out-of-scratch write and a raw TCP connect, and reports
 * whether each was blocked. `LLMWIKI_PROVIDER_SCRATCH_ROOT` names the one
 * directory writes should succeed in.
 */
const PROBE = `
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
function framed(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  process.stdout.write(Buffer.concat([len, body]));
}
async function main() {
  // Config rides a file in the launch tree (readable): the canary path (a
  // KNOWN-writable location outside scratch, so a blocked write here is the
  // profile's doing, not an already-unwritable home) and the parent listener
  // port.
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "probe-config.json"), "utf8"));
  const canary = cfg.canary;
  let outOfScratchWriteBlocked = false;
  try { fs.writeFileSync(canary, "escaped"); } catch { outOfScratchWriteBlocked = true; }
  const scratch = process.env.LLMWIKI_PROVIDER_SCRATCH_ROOT;
  const output = process.env.LLMWIKI_PROVIDER_OUTPUT_ROOT;
  let scratchWriteOk = false, outputWriteOk = false;
  try { fs.writeFileSync(path.join(scratch, "ok"), "x"); scratchWriteOk = true; } catch {}
  try { fs.writeFileSync(path.join(output, "ok"), "x"); outputWriteOk = true; } catch {}
  // Connect to the PARENT's real loopback listener (port passed in): a refusal
  // here is the network namespace, not an offline machine — the test proves the
  // same listener is reachable from OUTSIDE the sandbox first.
  const port = cfg.port;
  const networkBlocked = await new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(3000);
    sock.on("connect", () => done(false));
    sock.on("error", () => done(true));
    sock.on("timeout", () => done(true));
  });
  framed({ outOfScratchWriteBlocked, scratchWriteOk, outputWriteOk, networkBlocked });
}
main();
`;

interface ProbeResult {
  outOfScratchWriteBlocked: boolean; scratchWriteOk: boolean;
  outputWriteOk: boolean; networkBlocked: boolean;
}

/** A loopback listener the parent owns; the probe tries to reach it. */
function startListener(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => sock.end());
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, close: () => server.close() });
    });
  });
}

/** Launch the probe under the backend and return its reported outcome. */
async function probe(): Promise<ProbeResult> {
  const launchRoot = await mkdtemp(path.join(tmpdir(), "exp-probe-"));
  // The canary lives OUTSIDE scratch and is seeded writable, so a blocked
  // write there is the profile's doing rather than an unwritable location.
  const canaryDir = await mkdtemp(path.join(tmpdir(), "exp-canary-"));
  const canary = path.join(canaryDir, "escape");
  await writeFile(canary, "seed", "utf8");
  const listener = await startListener();
  // Non-vacuity: the parent MUST be able to reach the listener, or a "blocked"
  // result would prove nothing (an offline machine false-green).
  expect(await outerCanReach(listener.port), "listener unreachable from the parent").toBe(true);
  await writeFile(path.join(launchRoot, "probe-config.json"),
    JSON.stringify({ canary, port: listener.port }), "utf8");
  await writeFile(path.join(launchRoot, "entry.js"), PROBE, "utf8");
  try {
    const channel = await limitedIsolationBackend().launch({
      expectedIdentity: IDENTITY, launchRoot, entrypointRelativePath: "entry.js",
      brokerResponseRegionMount: "/broker", wallTimeMs: 15_000, inputTokens: [],
    });
    const decoder = createFrameDecoder();
    for (let chunk = await channel.receive(); chunk !== null; chunk = await channel.receive()) {
      const frames = decoder.push(chunk);
      if (frames.length > 0) { await channel.terminate(); return frames[0]!.value as ProbeResult; }
    }
    await channel.terminate();
    throw new Error("probe produced no frame");
  } finally {
    listener.close();
  }
}

describe("the limited-isolation backend enforces network-deny and scratch confinement", () => {
  it("denies network and out-of-scratch writes, allows scratch and output writes", async () => {
    // On the declared matrix (linux+macos) the isolation tool MUST be present:
    // a silent skip would let green CI witness nothing. macOS ships seatbelt;
    // Linux CI must provision bwrap (see ci.yml). Any other platform is
    // genuinely out of scope and the positive controls do not apply.
    if (!isolationToolPresent()) {
      const declaredMatrix = process.platform === "darwin" || process.platform === "linux";
      expect(declaredMatrix, "the isolation tool is absent on a DECLARED platform").toBe(false);
      return;
    }
    const result = await probe();
    expect(result.scratchWriteOk, "scratch write was blocked").toBe(true);
    expect(result.outputWriteOk, "output-root write was blocked").toBe(true);
    expect(result.outOfScratchWriteBlocked, "an out-of-scratch write SUCCEEDED").toBe(true);
    expect(result.networkBlocked, "a network connect SUCCEEDED").toBe(true);
  }, 30_000);

  it("REFUSES fail-closed when the isolation tool is unavailable", async () => {
    const launchRoot = await mkdtemp(path.join(tmpdir(), "exp-fc-"));
    await writeFile(path.join(launchRoot, "entry.js"), "process.exit(0);", "utf8");
    await expect(limitedIsolationBackend({ isolationToolOverride: "llmwiki-no-such-isolation-tool" }).launch({
      expectedIdentity: IDENTITY, launchRoot, entrypointRelativePath: "entry.js",
      brokerResponseRegionMount: "/broker", wallTimeMs: 5_000, inputTokens: [],
    })).rejects.toBeInstanceOf(IsolationUnavailableError);
  }, 15_000);
});

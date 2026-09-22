/**
 * @file test/capability-providers/invocation-lifecycle.test.ts
 * @description End-to-end provider invocation over a test-only fake backend
 * (D6.7 — never importable from src). It drives the real launch snapshot, input
 * materialization, broker-response region, and streaming custodian: the happy
 * path, a handshake echo violation, runtime custody exhaustion, the pre-launch
 * feasibility refusal, a premature stream close, and the D6.1 broker-response
 * token hand-off where large bytes reach the provider only as an opaque token.
 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { extractProviderArchive } from "../../src/capability-providers/packages/archive.js";
import { encodeFrame } from "../../src/capability-providers/runtime/framing.js";
import { PROVIDER_PROTOCOL_VERSION_V1 } from "../../src/capability-providers/runtime/types.js";
import type {
  LaunchSnapshotInputV1, ProviderBackendChannelV1,
  ProviderInvocationRequestV1, ProviderInvocationHostV1,
} from "../../src/capability-providers/runtime/invoke.js";
import { invokeCapabilityProvider } from "../../src/capability-providers/runtime/invoke.js";
import type { PlatformArtifactV1 } from "../../src/capability-providers/packages/protocol.js";
import { brokerAtom, prepareBrokerAuthority, useBrokerFixtures } from "./broker-fixture.js";
import { PROTOCOL_IDENTITY as IDENTITY } from "./protocol-identity-fixture.js";
import { providerDistribution, removeProviderFixtureRoot } from "../fixtures/capability-provider-package.js";

const trackFixture = useBrokerFixtures();
const INVOCATION = "invocation-lifecycle";
const NONCE = "nonce-xyz";
const REPORT_BYTES = "report-bytes";
const REPORT_DIGEST = `sha256:${createHash("sha256").update(REPORT_BYTES).digest("hex")}`;
const DECLARED = [{ outputId: "report", required: true, mediaType: "application/json" }];
const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map(removeProviderFixtureRoot)); });

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

/** Extract the signed fixture tree and describe it as one launch input. */
async function launchInput(): Promise<LaunchSnapshotInputV1> {
  const base = await tempDir("llmwiki-lifecycle-launch-");
  const source = path.join(base, "tree");
  await extractProviderArchive(providerDistribution().archive, providerDistribution().artifact as never, source);
  return { sourceTreeReal: await realpath(source), artifact: providerDistribution().artifact as unknown as PlatformArtifactV1, launchParentDir: base };
}

/** A scripted framed channel that replays provider frames and reports outputs. */
class ScriptedChannel implements ProviderBackendChannelV1 {
  readonly sent: unknown[] = [];
  private index = 0;
  constructor(private readonly frames: readonly unknown[], private readonly outputDir: string) {}
  async send(frame: Buffer): Promise<void> { this.sent.push(JSON.parse(frame.subarray(4).toString("utf8"))); }
  async receive(): Promise<Buffer | null> {
    return this.index >= this.frames.length ? null : encodeFrame(this.frames[this.index++]);
  }
  async outputRoot(): Promise<string> { return this.outputDir; }
  async terminate(): Promise<void> {}
}

/** A channel that replays already-framed raw byte chunks, for transport-edge cases. */
class RawChannel implements ProviderBackendChannelV1 {
  readonly sent: Buffer[] = [];
  private index = 0;
  constructor(private readonly chunks: readonly Buffer[], private readonly outputDir: string,
    private readonly onTerminate: () => void = () => {}) {}
  async send(frame: Buffer): Promise<void> { this.sent.push(frame); }
  async receive(): Promise<Buffer | null> {
    return this.index >= this.chunks.length ? null : this.chunks[this.index++]!;
  }
  async outputRoot(): Promise<string> { return this.outputDir; }
  async terminate(): Promise<void> { this.onTerminate(); }
}

/** A channel that hangs on receive (and optionally on the cancel send), recording terminate. */
class HungChannel implements ProviderBackendChannelV1 {
  readonly sent: unknown[] = [];
  terminated = false;
  private index = 0;
  constructor(private readonly frames: readonly unknown[], private readonly outputDir: string, private readonly hangCancelSend = false) {}
  async send(frame: Buffer): Promise<void> {
    const parsed = JSON.parse(frame.subarray(4).toString("utf8"));
    this.sent.push(parsed);
    if (this.hangCancelSend && (parsed as { type?: string }).type === "cancel") return new Promise<void>(() => {});
  }
  async receive(): Promise<Buffer | null> {
    return this.index < this.frames.length ? encodeFrame(this.frames[this.index++]) : new Promise<Buffer | null>(() => {});
  }
  async outputRoot(): Promise<string> { return this.outputDir; }
  async terminate(): Promise<void> { this.terminated = true; }
}

/** Invoke against a hung channel, abort mid-flight, and return the result + channel. */
async function invokeThenCancelHung(hangCancelSend: boolean): Promise<{ result: Awaited<ReturnType<typeof invokeCapabilityProvider>>; hung: HungChannel }> {
  const controller = new AbortController();
  let hung: HungChannel | undefined;
  const { request, host } = await baseRequest([], { hostSignal: controller.signal }, { report: REPORT_BYTES },
    (outputDir) => (hung = new HungChannel([initializedFrame()], outputDir, hangCancelSend)));
  const invocation = invokeCapabilityProvider(request, host);
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  return { result: await invocation, hung: hung! };
}

function providerFrame(type: string, sequence: number, extra: Record<string, unknown> = {}) {
  return { protocolVersion: PROVIDER_PROTOCOL_VERSION_V1, invocationId: INVOCATION,
    requestId: `p-${sequence}`, sequence, type, ...extra };
}

function initializedFrame(overrides: Record<string, unknown> = {}) {
  return providerFrame("initialized", 0, {
    selectedProtocolVersion: PROVIDER_PROTOCOL_VERSION_V1,
    echoedIdentity: {
      providerPinDigest: IDENTITY.providerPinDigest, packageDigest: IDENTITY.packageDigest,
      manifestDigest: IDENTITY.manifestDigest, artifactDigest: IDENTITY.artifactDigest,
      capabilityId: "analyze-sources", capabilitySchemaDigest: IDENTITY.capabilitySchemaDigest,
    },
    nonce: NONCE, declaredCapabilityId: "analyze-sources", ...overrides,
  });
}

function resultFrame(sequence: number, claims: unknown[]) {
  return providerFrame("result", sequence, { result: { outcome: "succeeded", artifactClaims: claims } });
}

function reportClaim(digest = REPORT_DIGEST, byteCount = REPORT_BYTES.length) {
  return { outputId: "report", outputToken: "report", claimedDigest: digest, claimedByteCount: byteCount };
}

const BROKER_REQUEST = { schemaVersion: 1, requestId: "r1", brokerId: "https", brokerContractVersion: "1.0.0",
  payload: { operation: "fetch-large", headers: {}, bodyBase64: null }, effect: null };

/** Handshake, one broker request, then a terminal result over the given claims. */
function brokerRoundTripFrames(claims: unknown[]) {
  return [initializedFrame(), providerFrame("broker-request", 1, { request: BROKER_REQUEST }), resultFrame(2, claims)];
}

/** Assert a completed invocation whose admitted result failed with `problem`. */
function expectAdmittedFailure(result: Awaited<ReturnType<typeof invokeCapabilityProvider>>, problem: string) {
  expect(result.kind).toBe("completed");
  if (result.kind !== "completed") return;
  expect(result.admitted.outcome).toBe("failed");
  if (result.admitted.outcome === "failed") expect(result.admitted.problem).toBe(problem);
}

async function baseRequest<C extends ProviderBackendChannelV1 = ScriptedChannel>(
  frames: readonly unknown[],
  overrides: Partial<ProviderInvocationRequestV1> = {}, outputFiles: Record<string, string> = { report: REPORT_BYTES },
  buildChannel: (outputDir: string) => C | ScriptedChannel = (outputDir) => new ScriptedChannel(frames, outputDir),
) {
  const authority = overrides.brokers ? [brokerAtom({ kind: "network.https", brokerId: "https",
    operation: "fetch-large", target: "https://api.example", method: "GET" })] : [];
  const fixture = trackFixture(await prepareBrokerAuthority({ authority }));
  const outputDir = await tempDir("llmwiki-lifecycle-out-");
  for (const [name, body] of Object.entries(outputFiles)) await writeFile(path.join(outputDir, name), body);
  const channel = buildChannel(outputDir);
  const request: ProviderInvocationRequestV1 = {
    paths: fixture.package.paths, invocationId: INVOCATION as never, nonce: NONCE,
    authorityRequest: fixture.request, expectedIdentity: IDENTITY, launch: await launchInput(),
    inputSpecs: [], input: { query: "sources" }, operationContext: {}, declaredOutputs: DECLARED,
    custodyValidators: [{ outputId: "report", maxOutputBytes: 50, worstCaseScanPasses: 1, worstCaseWallTimeMs: 50 }],
    brokers: {}, ...overrides,
  };
  const host: ProviderInvocationHostV1 = { backend: { launch: async () => channel } };
  return { request, host, channel };
}

describe("capability-provider invocation lifecycle", () => {
  it("completes a handshake-to-result invocation with custodied output", async () => {
    const { request, host, channel } = await baseRequest([initializedFrame(), resultFrame(1, [reportClaim()])]);
    const result = await invokeCapabilityProvider(request, host);
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") expect(result.admitted.outcome).toBe("succeeded");
    expect(channel.sent.map((frame) => (frame as { type: string }).type)).toEqual(["initialize", "invoke"]);
  });

  it("returns provider-cancelled and terminates the backend on a hung receive after cancel", async () => {
    const { result, hung } = await invokeThenCancelHung(false);
    expect(result).toMatchObject({ kind: "failed", problem: "provider-cancelled" });
    expect(hung.terminated).toBe(true);
  });

  it("returns and terminates the backend even when the cancel-frame send hangs", async () => {
    const { result, hung } = await invokeThenCancelHung(true);
    expect(result).toMatchObject({ kind: "failed", problem: "provider-cancelled" });
    expect(hung.terminated).toBe(true);
    expect((hung.sent.at(-1) as { type?: string }).type).toBe("cancel");
  });

  it("fails protocol-invalid on a handshake echo violation", async () => {
    const { request, host } = await baseRequest([initializedFrame({ nonce: "wrong" })]);
    expect(await invokeCapabilityProvider(request, host)).toMatchObject({ kind: "failed", problem: "provider-protocol-invalid" });
  });

  it("fails resource-exhausted when custody exhausts at runtime", async () => {
    const big = "x".repeat(200);
    const claim = reportClaim(`sha256:${createHash("sha256").update(big).digest("hex")}`, 200);
    const { request, host } = await baseRequest([initializedFrame(), resultFrame(1, [claim])], {}, { report: big });
    const result = await invokeCapabilityProvider(request, host);
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") expect(result.admitted.outcome).toBe("failed");
  });

  it("refuses before launch when declared custody exceeds the resolved grant bounds", async () => {
    const { request, host, channel } = await baseRequest([initializedFrame()]);
    const infeasible = { ...request, custodyValidators: [{ outputId: "report", maxOutputBytes: 900_000, worstCaseScanPasses: 3, worstCaseWallTimeMs: 50 }] };
    const result = await invokeCapabilityProvider(infeasible, host);
    expect(result).toMatchObject({ kind: "failed", problem: "provider-resource-exhausted" });
    expect(channel.sent).toHaveLength(0);
  });

  it("fails result-level when a custodied output reflects a secret from the corpus", async () => {
    const secret = "SUPERSECRET-TOKEN";
    const body = `analysis mentions ${secret} inline`;
    const claim = reportClaim(`sha256:${createHash("sha256").update(body).digest("hex")}`, body.length);
    const { request, host } = await baseRequest([initializedFrame(), resultFrame(1, [claim])],
      { secretCorpus: [Buffer.from(secret)] }, { report: body });
    expectAdmittedFailure(await invokeCapabilityProvider(request, host), "provider-output-invalid");
  });

  it("fails protocol-invalid when the stream closes before a terminal frame", async () => {
    const { request, host } = await baseRequest([initializedFrame()]);
    expect(await invokeCapabilityProvider(request, host)).toMatchObject({ kind: "failed", problem: "provider-protocol-invalid" });
  });

  it("hands a large broker response to the provider only as an opaque token", async () => {
    const frames = brokerRoundTripFrames([reportClaim()]);
    const { request, host, channel } = await baseRequest(frames, { brokers: httpsBroker(2 * 1_048_576) });
    const result = await invokeCapabilityProvider(request, host);
    expect(result.kind).toBe("completed");
    const response = channel.sent.find((frame) => (frame as { type: string }).type === "broker-response") as { response: { payload?: { token: string; byteCount: number } } };
    expect(response.response.payload?.token).toMatch(/^brp-[0-9a-f]{32}$/);
    expect(response.response.payload?.byteCount).toBe(2 * 1_048_576);
    expect(JSON.stringify(response)).not.toContain("aaaa");
  });

  it("shares one custody scan allowance across broker responses and outputs (F3)", async () => {
    // custodyScanBytes is the default fixture budget (100). A 60-byte broker
    // body and a 60-byte output each fit alone but together exhaust the one
    // allowance, so custody exhausts instead of granting each the full budget.
    const body = "o".repeat(60);
    const claim = reportClaim(`sha256:${createHash("sha256").update(body).digest("hex")}`, 60);
    const frames = brokerRoundTripFrames([claim]);
    const { request, host } = await baseRequest(frames,
      { brokers: httpsBroker(60), custodyValidators: [{ outputId: "report", maxOutputBytes: 60, worstCaseScanPasses: 1, worstCaseWallTimeMs: 50 }] },
      { report: body });
    expectAdmittedFailure(await invokeCapabilityProvider(request, host), "provider-resource-exhausted");
  });

  it("returns a closed protocol-invalid result on a framing error rather than rejecting (F4)", async () => {
    const zeroLengthFrame = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    const { request, host } = await baseRequest([], {}, { report: REPORT_BYTES },
      (dir) => new RawChannel([zeroLengthFrame], dir));
    expect(await invokeCapabilityProvider(request, host)).toMatchObject({ kind: "failed", problem: "provider-protocol-invalid" });
  });

  it("rejects trailing bytes after the terminal result frame (F4)", async () => {
    const terminalPlusPartial = Buffer.concat([encodeFrame(resultFrame(1, [reportClaim()])), Buffer.from([0x00, 0x00])]);
    const chunks = [encodeFrame(initializedFrame()), terminalPlusPartial];
    const { request, host } = await baseRequest([], {}, { report: REPORT_BYTES }, (dir) => new RawChannel(chunks, dir));
    expect(await invokeCapabilityProvider(request, host)).toMatchObject({ kind: "failed", problem: "provider-protocol-invalid" });
  });

  it("surfaces a disposer failure as a visible cleanup failure without flipping the outcome (F4)", async () => {
    const chunks = [encodeFrame(initializedFrame()), encodeFrame(resultFrame(1, [reportClaim()]))];
    const { request, host } = await baseRequest([], {}, { report: REPORT_BYTES },
      (dir) => new RawChannel(chunks, dir, () => { throw new Error("terminate failed"); }));
    const result = await invokeCapabilityProvider(request, host);
    expect(result.kind).toBe("completed");
    expect(result.cleanupFailures).toEqual(expect.arrayContaining([expect.stringContaining("terminate failed")]));
  });
});

/** Build an HTTPS broker adapter whose response body is `bodyBytes` long. */
function httpsBroker(bodyBytes: number) {
  const operation = { operationId: "fetch-large", origin: "https://api.example", path: "/large",
    method: "GET" as const, allowedRequestHeaders: [], contentTypes: ["application/json"],
    maxRequestHeaderBytes: 1_024, maxResponseHeaderBytes: 1_024, maxRequestBytes: 0,
    maxResponseBytes: 8 * 1_048_576, maxRedirects: 0, timeoutMs: 1_000 };
  return { https: { operations: [operation], seams: {
    lookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
    request: async () => ({ statusCode: 200, headers: { "content-type": "application/json" },
      body: Readable.from([Buffer.from("a".repeat(bodyBytes))]) }),
  } } };
}

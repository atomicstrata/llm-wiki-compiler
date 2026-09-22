/**
 * @file test/limited-isolation/probe-provider.ts
 * @description The source of a TRUSTED capability provider that speaks the real
 * Provider V2 protocol AND probes the limited-isolation backend's two enforced
 * controls from inside the sandbox, reporting what it observed as its answer.
 *
 * IT IS THE ECHO PROVIDER'S SHAPE WITH A PROBE FOR A BODY: the handshake and
 * artifact-claim mechanics are identical (a provider that skipped them would
 * prove nothing about the seam), but the extracted title ENCODES the probe
 * outcomes — whether a loopback connect was denied and whether a write outside
 * the scratch/output roots was blocked. The title travels through the runtime's
 * own protocol, custody, and evidence store into the durable phase output, so
 * the integration witness asserts the controls off the run's own record rather
 * than off anything the backend test already measured in-process.
 *
 * The probe CONFIG rides the rendered request ("Source: <port>|<canary-path>"),
 * because the request is the one sealed channel a pack-side execution hands its
 * provider — using it keeps the witness on the standard seam.
 */

/** The provider script. CommonJS, self-contained, no dependencies. */
export function probeProviderSource(): string {
  return `
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");

let buffered = Buffer.alloc(0);
let outbound = 0;

function send(body) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length, 0);
  process.stdout.write(Buffer.concat([prefix, payload]));
}

// A refusal here is the sandbox's doing: the witness proves the same listener
// is reachable from OUTSIDE the sandbox before the run, so "blocked" cannot be
// an offline machine.
function loopbackBlocked(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (blocked) => { try { sock.destroy(); } catch {} resolve(blocked); };
    sock.setTimeout(3000);
    sock.on("connect", () => done(false));
    sock.on("error", () => done(true));
    sock.on("timeout", () => done(true));
  });
}

async function probe(port, canary) {
  // The canary is a KNOWN-writable file outside scratch, seeded by the parent,
  // so a blocked write here is the profile's doing.
  let escapeBlocked = false;
  try { fs.writeFileSync(canary, "escaped"); } catch { escapeBlocked = true; }
  let scratchOk = false;
  try {
    fs.writeFileSync(path.join(process.env.LLMWIKI_PROVIDER_SCRATCH_ROOT, "ok"), "x");
    scratchOk = true;
  } catch {}
  const netBlocked = await loopbackBlocked(port);
  return "net=" + (netBlocked ? "blocked" : "open")
    + ";escape=" + (escapeBlocked ? "blocked" : "open")
    + ";scratch=" + (scratchOk ? "ok" : "blocked");
}

async function handle(frame) {
  if (frame.type === "initialize") {
    send({
      protocolVersion: frame.protocolVersion, invocationId: frame.invocationId,
      requestId: "provider-" + outbound, sequence: outbound++, type: "initialized",
      selectedProtocolVersion: frame.protocolVersion, echoedIdentity: frame.expectedIdentity,
      nonce: frame.nonce, declaredCapabilityId: frame.expectedIdentity.capabilityId,
    });
    return;
  }
  if (frame.type === "invoke") {
    const asked = String((frame.input && frame.input.request) || "");
    const config = ((asked.match(/Source: (.*)/) || [])[1] || "").trim();
    const [port, canary] = [config.split("|")[0], config.slice(config.indexOf("|") + 1)];
    const title = await probe(Number(port), canary);
    // The artifact write itself witnesses the OUTPUT root staying writable:
    // were it confined too, this write would throw and the phase would fail.
    const body = Buffer.from(JSON.stringify({
      items: [{ itemId: "probe-1", title, definition: "control probe report" }],
    }), "utf8");
    fs.writeFileSync(path.join(process.env.LLMWIKI_PROVIDER_OUTPUT_ROOT, "extraction"), body);
    const digest = "sha256:" + crypto.createHash("sha256").update(body).digest("hex");
    send({
      protocolVersion: frame.protocolVersion, invocationId: frame.invocationId,
      requestId: "provider-" + outbound, sequence: outbound++, type: "result",
      result: { outcome: "succeeded", artifactClaims: [{
        outputId: "extraction", outputToken: "extraction",
        claimedDigest: digest, claimedByteCount: body.length,
      }] },
    });
    process.stdout.end();
  }
}

process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  for (;;) {
    if (buffered.length < 4) return;
    const length = buffered.readUInt32BE(0);
    if (buffered.length < 4 + length) return;
    const body = buffered.subarray(4, 4 + length);
    buffered = buffered.subarray(4 + length);
    handle(JSON.parse(body.toString("utf8")));
  }
});
`;
}

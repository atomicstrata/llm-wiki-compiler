/**
 * @file test/dev-backend/echo-provider.ts
 * @description The source of a minimal capability provider that speaks the real
 * Provider V2 protocol, for driving a genuine child process end to end.
 *
 * IT IS REAL PROVIDER CODE, not a stub of one: it performs the handshake by
 * echoing the identity and nonce the host sent, then answers the invoke frame
 * with a result. A test double that skipped the handshake would prove nothing
 * about whether the adapter's request actually satisfies the runtime.
 */

/**
 * The provider script.
 *
 * IT DERIVES ITS ANSWER FROM THE REQUEST IT WAS SENT, rather than returning
 * canned data: a provider that ignores its input proves the process ran and
 * nothing about whether the source ever reached it. Here the extracted title is
 * built from the request text, so the journey's assertion fails unless the
 * rendered request — and therefore the operator's source — actually arrived.
 */
export function echoProviderSource(): string {
  return `
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

let buffered = Buffer.alloc(0);
let outbound = 0;

function send(body) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length, 0);
  process.stdout.write(Buffer.concat([prefix, payload]));
}

function handle(frame) {
  if (frame.type === "initialize") {
    // The handshake ECHOES what the host sent; inventing either field is how a
    // provider fails the runtime's identity check.
    send({
      protocolVersion: frame.protocolVersion, invocationId: frame.invocationId,
      requestId: "provider-" + outbound, sequence: outbound++, type: "initialized",
      selectedProtocolVersion: frame.protocolVersion, echoedIdentity: frame.expectedIdentity,
      nonce: frame.nonce, declaredCapabilityId: frame.expectedIdentity.capabilityId,
    });
    return;
  }
  if (frame.type === "invoke") {
    const root = process.env.LLMWIKI_PROVIDER_OUTPUT_ROOT;
    // The request the host sent, echoed into the answer. A provider that never
    // received it cannot produce this string.
    const asked = String((frame.input && frame.input.request) || "");
    const source = (asked.match(/Source: (.*)/) || [])[1] || "NO-SOURCE";
    const body = Buffer.from(JSON.stringify({
      items: [{
        itemId: "entity-1", title: "concept of " + source.trim(),
        definition: "extracted from " + source.trim(),
      }],
    }), "utf8");
    fs.writeFileSync(path.join(root, "extraction"), body);
    // The provider CLAIMS what it wrote; the host re-reads the file and refuses
    // a claim that does not match, so these are assertions it must honour.
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

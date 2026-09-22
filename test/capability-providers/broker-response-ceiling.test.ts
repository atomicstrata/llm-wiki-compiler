/**
 * @file test/capability-providers/broker-response-ceiling.test.ts
 * @description Host-side inline-response ceiling at the broker dispatch
 * boundary: a provider-visible result whose serialized frame exceeds the
 * protocol frame budget is refused with a typed bounds problem naming the
 * dimension, for HTTPS, model, and command visible output, and never inlined.
 */
import { describe, expect, it } from "vitest";
import { enforceInlineResponseCeiling } from "../../src/capability-providers/brokers/dispatch-outcome.js";
import { dispatchHostBrokerRequest } from "../../src/capability-providers/brokers/dispatch.js";
import { MAX_PROTOCOL_FRAME_BYTES } from "../../src/capability-providers/constants.js";
import { parseBrokerId, parseRequestId } from "../../src/capability-providers/ids.js";
import type { BrokerDispatchResultV1 } from "../../src/capability-providers/brokers/types.js";
import { brokerEnvelope, useBrokerFixtures } from "./broker-fixture.js";
import { makeHttpsDispatcher } from "./https-dispatcher-fixture.js";

const trackFixture = useBrokerFixtures();

describe("broker inline-response ceiling", () => {
  it.each([
    ["https", (pad: string) => ({ body: pad, finalUrl: "https://api.example/x", contentHash: "0".repeat(64) })],
    ["model", (pad: string) => ({ service: "svc", model: "m", output: pad })],
    ["command", (pad: string) => ({ exitCode: 0, stdout: pad, stderr: "" })],
  ])("passes a %s result at the frame budget and refuses one byte over", (brokerId, output) => {
    const base = result(brokerId, output(""));
    const overhead = frameBytes(base);
    const atBudget = result(brokerId, output("a".repeat(MAX_PROTOCOL_FRAME_BYTES - overhead)));
    expect(frameBytes(atBudget)).toBe(MAX_PROTOCOL_FRAME_BYTES);
    expect(enforceInlineResponseCeiling(atBudget)).toBe(atBudget);
    const overBudget = result(brokerId, output("a".repeat(MAX_PROTOCOL_FRAME_BYTES - overhead + 1)));
    const refused = enforceInlineResponseCeiling(overBudget);
    expect(refused.status).toBe("refused");
    expect(refused.output).toMatchObject({ dimension: "protocolBytes" });
  });

  it("refuses an oversized HTTPS response body at the real dispatch boundary", async () => {
    const dispatcher = await httpsDispatcher(MAX_PROTOCOL_FRAME_BYTES + 4_096);
    const result = await dispatchHostBrokerRequest(dispatcher, brokerEnvelope("https", {
      operation: "fetch-large", headers: {}, bodyBase64: null,
    }));
    expect(result.status).toBe("refused");
    expect(result.output).toMatchObject({ dimension: "protocolBytes" });
    expect(JSON.stringify(result).length).toBeLessThan(MAX_PROTOCOL_FRAME_BYTES);
  });

  it("returns an under-budget HTTPS response body inline", async () => {
    const dispatcher = await httpsDispatcher(1_024);
    const result = await dispatchHostBrokerRequest(dispatcher, brokerEnvelope("https", {
      operation: "fetch-large", headers: {}, bodyBase64: null,
    }));
    expect(result.status).toBe("ok");
  });
});

function result(brokerId: string, output: Record<string, unknown>): BrokerDispatchResultV1 {
  return Object.freeze({
    schemaVersion: 1, requestId: parseRequestId("request-ceiling"),
    brokerId: parseBrokerId(brokerId), status: "ok", output, receipt: null, completion: null,
  }) as BrokerDispatchResultV1;
}

function frameBytes(value: BrokerDispatchResultV1): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function httpsDispatcher(bodyBytes: number) {
  return makeHttpsDispatcher(trackFixture, {
    bodyBytes, invocationId: "invocation-ceiling",
    maxResponseBytes: MAX_PROTOCOL_FRAME_BYTES + 65_536,
  });
}

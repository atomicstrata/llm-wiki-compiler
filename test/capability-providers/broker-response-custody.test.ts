/**
 * @file test/capability-providers/broker-response-custody.test.ts
 * @description D6.1 broker-response custody hand-off. The host-only dispatch
 * sibling surfaces the large already-scanned response bytes structurally
 * separate from the provider-visible result, even when the inline response is
 * refused for exceeding the frame budget, while the provider-facing entrypoint
 * never carries those bytes. A credential-reflected response surfaces none.
 */
import { describe, expect, it } from "vitest";
import {
  dispatchHostBrokerRequest, dispatchHostBrokerRequestForHost,
} from "../../src/capability-providers/brokers/dispatch.js";
import { MAX_PROTOCOL_FRAME_BYTES } from "../../src/capability-providers/constants.js";
import { brokerEnvelope, useBrokerFixtures } from "./broker-fixture.js";
import { makeHttpsDispatcher } from "./https-dispatcher-fixture.js";

const trackFixture = useBrokerFixtures();

/** Build an HTTPS dispatcher whose response body is exactly `bodyBytes` long. */
async function httpsDispatcher(bodyBytes: number) {
  return makeHttpsDispatcher(trackFixture, {
    bodyBytes, invocationId: "invocation-custody",
    maxResponseBytes: MAX_PROTOCOL_FRAME_BYTES + 4 * 1_048_576,
  });
}

describe("broker-response custody hand-off", () => {
  it("surfaces oversized response bytes host-only while the inline result is refused", async () => {
    const overBudget = MAX_PROTOCOL_FRAME_BYTES + 2_048;
    const dispatcher = await httpsDispatcher(overBudget);
    const dispatch = await dispatchHostBrokerRequestForHost(dispatcher, brokerEnvelope("https", {
      operation: "fetch-large", headers: {}, bodyBase64: null,
    }));
    expect(dispatch.result.status).toBe("refused");
    const total = dispatch.visibleBytes.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    expect(total).toBe(overBudget);
  });

  it("never carries response bytes on the provider-facing entrypoint", async () => {
    const dispatcher = await httpsDispatcher(4_096);
    const result = await dispatchHostBrokerRequest(dispatcher, brokerEnvelope("https", {
      operation: "fetch-large", headers: {}, bodyBase64: null,
    }));
    expect(Object.hasOwn(result, "visibleBytes")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("visibleBytes");
  });

  it("surfaces under-budget bytes host-only alongside an inline ok result", async () => {
    const dispatcher = await httpsDispatcher(4_096);
    const dispatch = await dispatchHostBrokerRequestForHost(dispatcher, brokerEnvelope("https", {
      operation: "fetch-large", headers: {}, bodyBase64: null,
    }));
    expect(dispatch.result.status).toBe("ok");
    const total = dispatch.visibleBytes.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    expect(total).toBe(4_096);
  });
});

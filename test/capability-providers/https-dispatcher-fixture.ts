/**
 * @file test/capability-providers/https-dispatcher-fixture.ts
 * @description Shared HTTPS broker dispatcher fixture for the inline-response
 * ceiling and broker-response custody suites, so both drive one real dispatch
 * boundary with a configurable response-body size rather than copies.
 */
import { Readable } from "node:stream";
import { createHostBrokerDispatcher } from "../../src/capability-providers/brokers/dispatch.js";
import { parseInvocationId } from "../../src/capability-providers/ids.js";
import {
  brokerAtom, prepareBrokerAuthority, type BrokerAuthorityFixture,
} from "./broker-fixture.js";

export interface HttpsDispatcherOptionsV1 {
  readonly bodyBytes: number;
  readonly invocationId: string;
  readonly maxResponseBytes: number;
}

/** Persist real authority and return an HTTPS dispatcher over a fixed body. */
export async function makeHttpsDispatcher(
  track: (fixture: BrokerAuthorityFixture) => BrokerAuthorityFixture,
  options: HttpsDispatcherOptionsV1,
) {
  const authority = [brokerAtom({ kind: "network.https", brokerId: "https",
    operation: "fetch-large", target: "https://api.example", method: "GET" })];
  const fixture = track(await prepareBrokerAuthority({ authority }));
  const operation = { operationId: "fetch-large", origin: "https://api.example", path: "/large",
    method: "GET" as const, allowedRequestHeaders: [], contentTypes: ["application/json"],
    maxRequestHeaderBytes: 1_024, maxResponseHeaderBytes: 1_024, maxRequestBytes: 0,
    maxResponseBytes: options.maxResponseBytes, maxRedirects: 0, timeoutMs: 1_000 };
  const broker = { operations: [operation], seams: {
    lookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
    request: async () => ({ statusCode: 200, headers: { "content-type": "application/json" },
      body: Readable.from([Buffer.from("a".repeat(options.bodyBytes))]) }),
  } };
  return createHostBrokerDispatcher({
    paths: fixture.package.paths, authorityRequest: fixture.request,
    invocationId: parseInvocationId(options.invocationId), brokers: { https: broker },
  });
}

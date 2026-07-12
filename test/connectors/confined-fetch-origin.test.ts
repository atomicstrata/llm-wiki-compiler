/**
 * @file test/connectors/confined-fetch-origin.test.ts
 * @description Exact-origin and dual-byte-cap regressions for registry fetches.
 */
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  confinedFetch,
  type ConfinedFetchSeams,
  type ConfinedHttpResponse,
} from "../../src/connectors/confined-fetch.js";

const LIMITS = {
  timeoutMs: 100,
  maxBytes: 64,
  maxTransportBytes: 8,
  maxRedirects: 1,
  contentTypes: ["application/json"],
};
const POLICY = { allowedHosts: ["tap.example"], allowedOrigins: ["https://tap.example"] };

function response(statusCode: number, headers: Record<string, string>, body = "{}"): ConfinedHttpResponse {
  return { statusCode, headers, body: Readable.from([body]) };
}

function seams(responses: ConfinedHttpResponse[]): ConfinedFetchSeams {
  return {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => responses.shift()!,
  };
}

describe("confinedFetch exact-origin policy", () => {
  it("accepts the configured origin and rejects the same host on another port", async () => {
    const ok = await confinedFetch(
      { url: "https://tap.example/index.json" }, LIMITS, POLICY,
      seams([response(200, { "content-type": "application/json" })]),
    );
    const refused = await confinedFetch(
      { url: "https://tap.example:444/index.json" }, LIMITS, POLICY,
      seams([response(200, { "content-type": "application/json" })]),
    );
    expect(ok.kind).toBe("ok");
    expect(refused).toMatchObject({ kind: "refused" });
  });

  it("refuses a redirect that changes only the port", async () => {
    const result = await confinedFetch(
      { url: "https://tap.example/index.json" }, LIMITS, POLICY,
      seams([response(302, { location: "https://tap.example:444/index.json" })]),
    );
    expect(result).toMatchObject({ kind: "refused" });
  });

  it("refuses a malformed redirect without throwing or leaving the body open", async () => {
    const redirect = response(302, { location: "https://[invalid" });
    const result = await confinedFetch(
      { url: "https://tap.example/index.json" }, LIMITS, POLICY, seams([redirect]),
    );
    expect(result).toMatchObject({ kind: "refused" });
    expect(redirect.body.destroyed).toBe(true);
  });

  it("normalizes DNS failures to unavailable", async () => {
    const result = await confinedFetch({ url: "https://tap.example/index.json" }, LIMITS, POLICY, {
      lookup: async () => { throw new Error("resolver down"); },
    });
    expect(result).toEqual({ kind: "unavailable", reason: "connector host lookup failed" });
  });
});

describe("confinedFetch transport byte cap", () => {
  it("refuses an identity body over the transport cap", async () => {
    const result = await confinedFetch(
      { url: "https://tap.example/index.json" }, LIMITS, POLICY,
      seams([response(200, { "content-type": "application/json" }, "123456789")]),
    );
    expect(result).toEqual({ kind: "refused", reason: "connector response exceeds transport byte cap" });
  });

  it("applies the transport cap before gzip decoding", async () => {
    const { gzipSync } = await import("node:zlib");
    const compressed = gzipSync(Buffer.from("{}"));
    const result = await confinedFetch(
      { url: "https://tap.example/index.json" }, LIMITS, POLICY,
      seams([{ statusCode: 200, headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: Readable.from([compressed]) }]),
    );
    expect(result).toEqual({ kind: "refused", reason: "connector response exceeds transport byte cap" });
  });

  it("destroys a rejected response body", async () => {
    const body = Readable.from(["ignored"]);
    const result = await confinedFetch({ url: "https://tap.example/index.json" }, LIMITS, POLICY, {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => ({ statusCode: 200, headers: { "content-type": "text/html" }, body }),
    });
    expect(result.kind).toBe("refused");
    expect(body.destroyed).toBe(true);
  });
});

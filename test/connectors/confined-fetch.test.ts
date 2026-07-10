/**
 * @file test/connectors/confined-fetch.test.ts
 * @description SSRF and resource-bound tests for the connector network primitive.
 */
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  confinedFetch,
  type ConfinedFetchSeams,
  type ConfinedHttpRequest,
  type ConfinedHttpResponse,
} from "../../src/connectors/confined-fetch.js";
import { isPrivateAddress } from "../../src/connectors/private-address.js";

const LIMITS = { timeoutMs: 100, maxBytes: 64, maxRedirects: 1, contentTypes: ["application/json"] };
const PUBLIC_IP = "93.184.216.34";

function bodyStream(body: string | Buffer): Readable {
  return Readable.from([body]);
}

function response(
  statusCode: number,
  headers: Record<string, string>,
  body: string | Buffer = "{}",
): ConfinedHttpResponse {
  return { statusCode, headers, body: bodyStream(body) };
}

function seamsFor(responses: ConfinedHttpResponse[], seen: ConfinedHttpRequest[] = []): ConfinedFetchSeams {
  return {
    lookup: async () => [{ address: PUBLIC_IP, family: 4 }],
    request: async (request) => {
      seen.push(request);
      return responses.shift() ?? response(200, { "content-type": "application/json" });
    },
  };
}

/** Expect the request to be refused before any socket is dialed. */
async function expectRefusedBeforeDialing(request: { url: string; headers?: Record<string, string> }): Promise<void> {
  const seen: ConfinedHttpRequest[] = [];
  const result = await confinedFetch(
    request,
    LIMITS,
    ["api.crossref.org"],
    seamsFor([response(200, { "content-type": "application/json" })], seen),
  );
  expect(result.kind).toBe("refused");
  expect(seen).toHaveLength(0);
}

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1", "0.0.0.0", "10.1.2.3", "169.254.169.254", "::1", "64:ff9b::7f00:1", "2002:7f00:1::",
    "::127.0.0.1", "::7f00:1", "::a00:1",
  ])(
    "rejects private or special address %s",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );

  it.each(["8.8.8.8", "2606:4700:4700::1111"])("allows public address %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("confinedFetch URL policy", () => {
  it("refuses non-https URLs", async () => {
    const result = await confinedFetch({ url: "http://api.crossref.org/works/10.1/x" }, LIMITS, ["api.crossref.org"]);
    expect(result.kind).toBe("refused");
  });

  it("refuses userinfo and suffix host tricks by hostname equality", async () => {
    const result = await confinedFetch({ url: "https://api.crossref.org@evil.test/" }, LIMITS, ["api.crossref.org"]);
    expect(result.kind).toBe("refused");
  });

  it("refuses private DNS results before dialing", async () => {
    const result = await confinedFetch({ url: "https://api.crossref.org/" }, LIMITS, ["api.crossref.org"], {
      lookup: async () => [{ address: "169.254.169.254", family: 4 }],
      request: async () => response(200, { "content-type": "application/json" }),
    });
    expect(result.kind).toBe("refused");
  });

  it("pins the resolved address while preserving TLS servername and Host", async () => {
    const seen: ConfinedHttpRequest[] = [];
    const result = await confinedFetch(
      { url: "https://api.crossref.org/works/10.1/x" },
      LIMITS,
      ["api.crossref.org"],
      seamsFor([response(200, { "content-type": "application/json" })], seen),
    );
    expect(result.kind).toBe("ok");
    expect(seen[0]).toMatchObject({ hostname: PUBLIC_IP, servername: "api.crossref.org", hostHeader: "api.crossref.org" });
  });

  it("refuses over-long URLs before dialing", async () => {
    await expectRefusedBeforeDialing({ url: `https://api.crossref.org/works/${"x".repeat(2100)}` });
  });

  it("refuses URLs whose canonical form exceeds the byte cap", async () => {
    // 930 raw bytes, but percent-encoding expands each 3-byte snowman to 9 bytes (~2730).
    await expectRefusedBeforeDialing({ url: `https://api.crossref.org/works/${"☃".repeat(300)}` });
  });

  it("refuses redirects to over-long URLs", async () => {
    const seen: ConfinedHttpRequest[] = [];
    const result = await confinedFetch(
      { url: "https://api.crossref.org/works/10.1/x" },
      LIMITS,
      ["api.crossref.org"],
      seamsFor([
        response(302, { location: `https://api.crossref.org/${"y".repeat(2100)}` }),
        response(200, { "content-type": "application/json" }),
      ], seen),
    );
    expect(result.kind).toBe("refused");
    expect(seen).toHaveLength(1);
  });

  it("refuses CRLF header injection before dialing", async () => {
    await expectRefusedBeforeDialing({
      url: "https://api.crossref.org/",
      headers: { "User-Agent": "llmwiki\r\nX-Bad: yes" },
    });
  });
});

describe("confinedFetch response policy", () => {
  it("revalidates redirects and refuses private redirect targets", async () => {
    const seen: ConfinedHttpRequest[] = [];
    const result = await confinedFetch(
      { url: "https://api.crossref.org/start" },
      LIMITS,
      ["api.crossref.org", "169.254.169.254"],
      {
        lookup: async (host) => [{ address: host === "169.254.169.254" ? "169.254.169.254" : PUBLIC_IP, family: 4 }],
        request: async (request) => {
          seen.push(request);
          return response(302, { location: "https://169.254.169.254/latest" });
        },
      },
    );
    expect(result.kind).toBe("refused");
    expect(seen).toHaveLength(1);
  });

  it("refuses unsupported response encodings", async () => {
    const result = await confinedFetch(
      { url: "https://api.crossref.org/" },
      LIMITS,
      ["api.crossref.org"],
      seamsFor([response(200, { "content-type": "application/json", "content-encoding": "br" })]),
    );
    expect(result.kind).toBe("refused");
  });

  it("refuses wrong content types", async () => {
    const result = await confinedFetch(
      { url: "https://api.crossref.org/" },
      LIMITS,
      ["api.crossref.org"],
      seamsFor([response(200, { "content-type": "text/html" }, "<html></html>")]),
    );
    expect(result.kind).toBe("refused");
  });

  it("caps decoded gzip bytes incrementally", async () => {
    const gzipped = gzipSync(Buffer.alloc(128, "x"));
    const result = await confinedFetch(
      { url: "https://api.crossref.org/" },
      LIMITS,
      ["api.crossref.org"],
      seamsFor([response(200, { "content-type": "application/json", "content-encoding": "gzip" }, gzipped)]),
    );
    expect(result.kind).toBe("refused");
  });

  it("carries one timeout budget across redirects", async () => {
    const seen: ConfinedHttpRequest[] = [];
    const result = await confinedFetch({ url: "https://api.crossref.org/start" }, LIMITS, ["api.crossref.org"], {
      ...seamsFor([
        response(302, { location: "https://api.crossref.org/final" }),
        response(200, { "content-type": "application/json" }),
      ], seen),
      now: (() => {
        const times = [0, 75];
        return () => times.shift() ?? 75;
      })(),
    });
    expect(result.kind).toBe("ok");
    expect(seen.map((request) => request.timeoutMs)).toEqual([100, 25]);
  });

  it("enforces the timeout budget while consuming response bytes", async () => {
    const times = [0, 0, 101];
    const result = await confinedFetch(
      { url: "https://api.crossref.org/" },
      LIMITS,
      ["api.crossref.org"],
      {
        ...seamsFor([response(200, { "content-type": "application/json" }, "{}")]),
        now: () => times.shift() ?? 101,
      },
    );

    expect(result).toEqual({ kind: "unavailable", reason: "connector fetch timed out" });
  });
});

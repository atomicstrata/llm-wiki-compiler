/**
 * @file test/capability-providers/broker-secret-reflection.test.ts
 * @description Credential isolation tests across HTTPS and command brokers,
 * including exact credential-operation authority, encoded reflection, and a
 * secret-bearing suffix beyond the tightened full-scan response ceiling.
 */
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createHostBrokerDispatcher, dispatchHostBrokerRequest, readHostBrokerUsage,
} from "../../src/capability-providers/brokers/dispatch.js";
import { parseInvocationId } from "../../src/capability-providers/ids.js";
import {
  brokerAtom, brokerEnvelope, prepareBrokerAuthority, useBrokerFixtures,
} from "./broker-fixture.js";

const SECRET = "task6-secret-token";
const trackFixture = useBrokerFixtures(() => {
  delete process.env.LLMWIKI_TEST_PROVIDER_TASK6_SECRET;
});

describe("broker credential reflection", () => {
  it("uses the narrow operator HTTPS transfer bound before transport I/O", async () => {
    const { dispatcher, httpRequest } = await setup(Buffer.from("{}"), {
      httpsTransferBytes: 32,
    });
    expect((await dispatchHostBrokerRequest(dispatcher, httpsRequest())).status).toBe("refused");
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it("refuses a secret reflected near the end of every credential-visible HTTPS byte", async () => {
    const body = Buffer.alloc(4 * 1024 * 1024, 0x78);
    body.write(SECRET, body.length - SECRET.length);
    const { dispatcher, httpRequest } = await setup(body);
    const result = await dispatchHostBrokerRequest(dispatcher, httpsRequest());
    expect(result).toMatchObject({ status: "refused", output: { reason: "broker output was refused" } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(httpRequest).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${SECRET}` }),
    }));
  });

  it("never releases an unscanned credential response suffix beyond the tightened cap", async () => {
    const body = Buffer.concat([Buffer.alloc(4 * 1024 * 1024, 0x78), Buffer.from(SECRET)]);
    const { dispatcher } = await setup(body);
    const result = await dispatchHostBrokerRequest(dispatcher, httpsRequest());
    expect(result.status).toBe("refused");
    expect(readHostBrokerUsage(dispatcher).httpsTransferBytes).toBe(8 * 1024 * 1024);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("refuses encoded secret reflection from registered command output", async () => {
    const { dispatcher } = await setup(Buffer.from("{}"), {
      commandOutput: Buffer.from(SECRET).toString("base64"),
    });
    const result = await dispatchHostBrokerRequest(dispatcher, commandRequest());
    expect(result.status).toBe("refused");
    expect(JSON.stringify(result)).not.toContain(Buffer.from(SECRET).toString("base64"));
  });

  it("scans the complete HTTPS output including a same-origin final URL", async () => {
    const { dispatcher } = await setup(Buffer.from("{}"), { httpsPath: `/${SECRET}` });
    const result = await dispatchHostBrokerRequest(dispatcher, httpsRequest());
    expect(result.status).toBe("refused");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("requires the exact credential operation before any broker I/O", async () => {
    const { dispatcher, httpRequest } = await setup(Buffer.from("{}"), {
      httpsCredentialOperation: "different-operation",
    });
    await expect(dispatchHostBrokerRequest(dispatcher, httpsRequest()))
      .rejects.toThrow(/credential.*authority|authority.*missing/i);
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it.each(credentialRepresentations())(
    "refuses a $name credential form crossing the former 4 KiB scan boundary",
    async ({ encoded }) => {
      const commandOutput = `${"x".repeat(4_090)}${encoded}`;
      const { dispatcher } = await setup(Buffer.from("{}"), { commandOutput });
      const result = await dispatchHostBrokerRequest(dispatcher, commandRequest());
      expect(result.status).toBe("refused");
      expect(JSON.stringify(result)).not.toContain(encoded);
    },
  );
});

interface SetupOptions {
  readonly commandOutput?: string;
  readonly httpsCredentialOperation?: string;
  readonly httpsPath?: string;
  readonly httpsTransferBytes?: number;
}

async function setup(responseBody: Buffer, options: SetupOptions = {}) {
  process.env.LLMWIKI_TEST_PROVIDER_TASK6_SECRET = SECRET;
  const httpRequest = vi.fn(async () => ({
    statusCode: 200, headers: { "content-type": "application/json" },
    body: Readable.from([responseBody]),
  }));
  const run = vi.fn(async () => ({
    exitCode: 0, stdout: Buffer.from(options.commandOutput ?? "ok"), stderr: Buffer.alloc(0),
  }));
  const authority = reflectionAuthority(options.httpsCredentialOperation ?? "fetch-private");
  const fixture = trackFixture(await prepareBrokerAuthority({ authority,
    ...(options.httpsTransferBytes === undefined ? {} : { brokerMaximumOverrides: {
      operator: { httpsTransferBytes: options.httpsTransferBytes },
    } }),
  }));
  const dispatcher = await createHostBrokerDispatcher({
    paths: fixture.package.paths, authorityRequest: fixture.request,
    invocationId: parseInvocationId("invocation-reflection"), brokers: {
      https: { operations: [{
        operationId: "fetch-private", origin: "https://api.example", path: options.httpsPath ?? "/private",
        method: "GET", allowedRequestHeaders: [], contentTypes: ["application/json"],
        maxRequestHeaderBytes: 4_096, maxResponseHeaderBytes: 4_096,
        maxRequestBytes: 0, maxResponseBytes: 8 * 1024 * 1024,
        maxRedirects: 1, timeoutMs: 1_000,
        credential: { slotId: "api-token", headerName: "Authorization", valuePrefix: "Bearer " },
      }], seams: { lookup: publicLookup, request: httpRequest } },
      command: { workingDirectoryToken: "cwd-invocation-reflection", operations: [{
        operationId: "credential-tool", targetIdentity: "credential-tool",
        toolId: "credential-tool", executable: "/usr/bin/credential-tool",
        arguments: [], environment: {}, timeoutMs: 1_000, maxAcceptedBytes: 8_192,
        credential: { slotId: "command-token", environmentName: "TOOL_TOKEN" },
      }], run },
    },
  });
  return { dispatcher, httpRequest, run };
}

function reflectionAuthority(httpsCredentialOperation: string) {
  return [
    brokerAtom({ kind: "network.https", brokerId: "https", operation: "fetch-private",
      target: "https://api.example", method: "GET" }),
    brokerAtom({ kind: "credential.use", brokerId: "https", operation: httpsCredentialOperation,
      credentialSlotId: "api-token" }),
    brokerAtom({ kind: "command.execute", brokerId: "command", operation: "credential-tool",
      target: "credential-tool", toolId: "credential-tool" }),
    brokerAtom({ kind: "credential.use", brokerId: "command", operation: "credential-tool",
      credentialSlotId: "command-token" }),
  ];
}

function httpsRequest() {
  return brokerEnvelope("https", { operation: "fetch-private", headers: {}, bodyBase64: null });
}
function commandRequest() {
  return brokerEnvelope("command", { operation: "credential-tool", arguments: {} });
}
async function publicLookup() {
  return [{ address: "93.184.216.34", family: 4 as const }];
}

function credentialRepresentations() {
  const bytes = Buffer.from(SECRET);
  return [
    { name: "raw", encoded: SECRET },
    { name: "base64", encoded: bytes.toString("base64") },
    { name: "base64url", encoded: bytes.toString("base64url") },
    { name: "hex", encoded: bytes.toString("hex") },
    { name: "percent", encoded: [...bytes].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("") },
  ];
}

/**
 * @file test/capability-providers/broker-deadline-inflight.test.ts
 * @description The host wall-time deadline is wired into each read-only broker
 * adapter's underlying I/O: an in-flight HTTPS request, command run, and
 * repository snapshot all abort when the host deadline fires and settle as a
 * typed unavailable outcome rather than outliving the invocation.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createHostBrokerDispatcher, dispatchHostBrokerRequest,
} from "../../src/capability-providers/brokers/dispatch.js";
import { parseInvocationId } from "../../src/capability-providers/ids.js";
import {
  brokerAtom, brokerEnvelope, prepareBrokerAuthority, useBrokerFixtures,
} from "./broker-fixture.js";

const trackFixture = useBrokerFixtures();
const COMMIT = "a".repeat(40);

describe("read-only broker deadline in-flight abort", () => {
  it("aborts an in-flight HTTPS request when the host deadline fires", async () => {
    const controller = new AbortController();
    const request = vi.fn((req: { readonly signal?: AbortSignal }) => hangUntilAbort(req.signal));
    const { dispatcher, envelope } = await httpsDispatcher(controller.signal, request);
    const pending = dispatchHostBrokerRequest(dispatcher, envelope);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    controller.abort();
    expect((await pending).status).toBe("unavailable");
  });

  it("aborts an in-flight registered command when the host deadline fires", async () => {
    const controller = new AbortController();
    const run = vi.fn((req: { readonly signal: AbortSignal }) => hangUntilAbort(req.signal));
    const { dispatcher, envelope } = await commandDispatcher(controller.signal, run);
    const pending = dispatchHostBrokerRequest(dispatcher, envelope);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    controller.abort();
    expect((await pending).status).toBe("unavailable");
  });

  it("aborts an in-flight repository snapshot when the host deadline fires", async () => {
    const controller = new AbortController();
    const snapshot = vi.fn((_operation: unknown, signal: AbortSignal) => hangUntilAbort(signal));
    const { dispatcher, envelope } = await repositoryDispatcher(controller.signal, snapshot);
    const pending = dispatchHostBrokerRequest(dispatcher, envelope);
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    controller.abort();
    expect((await pending).status).toBe("unavailable");
  });
});

function hangUntilAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal || signal.aborted) return reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

async function dispatcher(
  authority: ReturnType<typeof brokerAtom>[], brokers: Record<string, unknown>,
  deadlineSignal: AbortSignal,
) {
  const fixture = trackFixture(await prepareBrokerAuthority({ authority }));
  return createHostBrokerDispatcher({
    paths: fixture.package.paths, authorityRequest: fixture.request,
    invocationId: parseInvocationId("invocation-inflight"), brokers, deadlineSignal,
  });
}

async function httpsDispatcher(
  deadlineSignal: AbortSignal, request: (req: { readonly signal?: AbortSignal }) => Promise<never>,
) {
  const authority = [brokerAtom({ kind: "network.https", brokerId: "https",
    operation: "fetch", target: "https://api.example", method: "GET" })];
  const operation = { operationId: "fetch", origin: "https://api.example", path: "/x",
    method: "GET" as const, allowedRequestHeaders: [], contentTypes: ["application/json"],
    maxRequestHeaderBytes: 1_024, maxResponseHeaderBytes: 1_024, maxRequestBytes: 0,
    maxResponseBytes: 1_024, maxRedirects: 0, timeoutMs: 60_000 };
  const broker = { operations: [operation], seams: {
    lookup: async () => [{ address: "93.184.216.34", family: 4 as const }], request } };
  return {
    dispatcher: await dispatcher(authority, { https: broker }, deadlineSignal),
    envelope: brokerEnvelope("https", { operation: "fetch", headers: {}, bodyBase64: null }),
  };
}

async function commandDispatcher(
  deadlineSignal: AbortSignal, run: (req: { readonly signal: AbortSignal }) => Promise<never>,
) {
  const authority = [brokerAtom({ kind: "command.execute", brokerId: "command",
    operation: "search", target: "registered-search", toolId: "registered-tool" })];
  const operation = { operationId: "search", targetIdentity: "registered-search",
    toolId: "registered-tool", executable: "/usr/bin/true",
    arguments: [{ name: "query", flag: "--query", type: "string" as const }],
    environment: {}, timeoutMs: 60_000, maxAcceptedBytes: 1_024 };
  const broker = { workingDirectoryToken: "cwd-inflight", operations: [operation], run };
  return {
    dispatcher: await dispatcher(authority, { command: broker }, deadlineSignal),
    envelope: brokerEnvelope("command", { operation: "search", arguments: { query: "safe" } }),
  };
}

async function repositoryDispatcher(
  deadlineSignal: AbortSignal, snapshot: (operation: unknown, signal: AbortSignal) => Promise<never>,
) {
  const authority = [brokerAtom({ kind: "repository.snapshot", brokerId: "repository",
    operation: "snapshot-main", target: "https://git.example/repo.git" })];
  const operation = { operationId: "snapshot-main", remoteIdentity: "https://git.example/repo.git",
    commit: COMMIT, maxObjectBytes: 100, maxCheckoutBytes: 100, maxFiles: 10,
    pathPrefixes: ["src/"], submodules: "forbid" as const, lfs: "forbid" as const };
  const broker = { operations: [operation], snapshot };
  return {
    dispatcher: await dispatcher(authority, { repository: broker }, deadlineSignal),
    envelope: brokerEnvelope("repository", { operation: "snapshot-main", commit: COMMIT }),
  };
}

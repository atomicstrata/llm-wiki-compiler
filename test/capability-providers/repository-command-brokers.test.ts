/**
 * @file test/capability-providers/repository-command-brokers.test.ts
 * @description Repository commit-pin and command typed-argv integration tests,
 * including moving-ref refusal and hostile shell-string preservation.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createHostBrokerDispatcher, dispatchHostBrokerRequest,
} from "../../src/capability-providers/brokers/dispatch.js";
import { parseInvocationId, parseSha256Digest } from "../../src/capability-providers/ids.js";
import {
  brokerAtom, brokerEnvelope, prepareBrokerAuthority, useBrokerFixtures,
} from "./broker-fixture.js";

const COMMIT = "a".repeat(40);
const trackFixture = useBrokerFixtures();

describe("repository snapshot broker", () => {
  it.each([
    ["negative", { maxObjectBytes: -1 }],
    ["fractional", { maxCheckoutBytes: 1.5 }],
    ["unsafe", { maxFiles: Number.MAX_SAFE_INTEGER + 1 }],
    ["contradictory", { maxObjectBytes: 101, maxCheckoutBytes: 100 }],
  ])("rejects %s repository maxima before snapshot I/O", async (_kind, override) => {
    const snapshot = vi.fn();
    const broker = repositoryBroker(snapshot);
    Object.assign(broker.operations[0], override);
    const dispatcher = await setup({ repository: broker });
    await expect(dispatchHostBrokerRequest(dispatcher, repositoryRequest(COMMIT)))
      .rejects.toThrow(/repository.*invalid/i);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("rejects broker-definition accessors when the dispatcher captures adapters", async () => {
    const broker = {} as Record<string, unknown>;
    Object.defineProperty(broker, "operations", { get: () => [] });
    broker.snapshot = vi.fn();
    await expect(setup({ repository: broker })).rejects.toThrow(/adapter.*invalid/i);
  });

  it("returns only an opaque snapshot for the exact observed commit", async () => {
    const dispatcher = await setup({ repository: repositoryBroker(vi.fn(compliantSnapshot)) });
    const result = await dispatchHostBrokerRequest(dispatcher, repositoryRequest(COMMIT));
    expect(result).toMatchObject({ status: "ok", output: {
      snapshotToken: "snapshot-one", commit: COMMIT, fileCount: 2,
    } });
    expect(JSON.stringify(result)).not.toMatch(/\/Users\/|submodules|hooksInstalled/);
  });

  it.each([
    ["a wrong commit digest", { commit: "b".repeat(40) }],
    ["over-cap object bytes", { objectBytes: 101 }],
    ["over-cap file counts", { fileCount: 11 }],
    ["an unasserted submodule disposition", { submodules: "included" }],
    ["an unasserted LFS disposition", { lfs: "included" }],
    ["installed hooks", { hooksInstalled: true }],
  ])("refuses a lying repository adapter reporting %s", async (_kind, override) => {
    const snapshot = vi.fn(async () => ({ ...(await compliantSnapshot()), ...override }));
    const dispatcher = await setup({ repository: repositoryBroker(snapshot) });
    const result = await dispatchHostBrokerRequest(dispatcher, repositoryRequest(COMMIT));
    expect(result).toMatchObject({ status: "refused" });
  });

  it("surfaces a partial checkout distinctly with host completion evidence", async () => {
    const result = await dispatchWithCompletion({ completed: 1, attempted: 2 });
    expect(result.status).toBe("partial");
    expect(result.completion).toEqual({ completed: 1, attempted: 2 });
    expect(result.output).toMatchObject({ commit: COMMIT });
  });

  it("reports a fully completed checkout as ok with no completion evidence", async () => {
    const result = await dispatchWithCompletion({ completed: 2, attempted: 2 });
    expect(result.status).toBe("ok");
    expect(result.completion).toBeNull();
  });

  it("rejects partial completion evidence that exceeds what was attempted", async () => {
    const result = await dispatchWithCompletion({ completed: 3, attempted: 2 });
    expect(result.status).toBe("unavailable");
  });

  it("refuses a moving or mismatched commit before repository I/O", async () => {
    const snapshot = vi.fn();
    const dispatcher = await setup({ repository: repositoryBroker(snapshot) });
    await expect(dispatchHostBrokerRequest(dispatcher, repositoryRequest("b".repeat(40))))
      .rejects.toThrow(/repository.*invalid/i);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("refuses host operation-definition drift before adapter I/O", async () => {
    const snapshot = vi.fn();
    const broker = repositoryBroker(snapshot);
    const dispatcher = await setup({ repository: broker });
    broker.operations[0].commit = "b".repeat(40);
    await expect(dispatchHostBrokerRequest(dispatcher, repositoryRequest(COMMIT)))
      .rejects.toThrow(/definition.*drift/i);
    expect(snapshot).not.toHaveBeenCalled();
  });
});

describe("command broker", () => {
  it("passes the narrow per-broker command-byte maximum to the runner", async () => {
    const run = successfulCommandRun();
    const dispatcher = await setup({ command: commandBroker(run) }, {
      action: { commandAcceptedBytes: 3 },
    });
    expect((await dispatchHostBrokerRequest(dispatcher, commandRequest("safe"))).status).toBe("ok");
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ maxAcceptedBytes: 3 }));
  });

  it.each([
    ["single", new Uint8Array(1_025), new Uint8Array(0)],
    ["combined", new Uint8Array(600), new Uint8Array(500)],
  ])("rejects oversized %s output before copying adapter views", async (_kind, stdout, stderr) => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout, stderr }));
    const dispatcher = await setup({ command: commandBroker(run) });
    const copied = vi.spyOn(Buffer, "from");
    try {
      const result = await dispatchHostBrokerRequest(dispatcher, commandRequest("safe"));
      expect(result.status).toBe("refused");
      expect(copied.mock.calls.some(([value]) => value === stdout || value === stderr)).toBe(false);
    } finally { copied.mockRestore(); }
  });

  it("passes metacharacters as one typed argv value with no shell or PATH", async () => {
    const run = successfulCommandRun();
    const dispatcher = await setup({ command: commandBroker(run) });
    const result = await dispatchHostBrokerRequest(dispatcher, commandRequest("x; touch /tmp/pwned"));
    expect(result.status).toBe("ok");
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      executable: "/usr/bin/registered-tool", argv: ["--query=x; touch /tmp/pwned"],
      shell: false, stdin: null, environment: { LANG: "C" },
      workingDirectoryToken: "cwd-invocation-tools", descriptorPolicy: "closed",
      interactionPolicy: "noninteractive", deadlinePolicy: "terminate-process-tree",
    }));
  });

  it("rejects provider executable, environment, and response-file fields", async () => {
    const run = vi.fn();
    const dispatcher = await setup({ command: commandBroker(run) });
    const request = brokerEnvelope("command", {
      operation: "search", arguments: { query: "safe" }, executable: "/bin/sh",
    });
    await expect(dispatchHostBrokerRequest(dispatcher, request)).rejects.toThrow(/command.*invalid/i);
    expect(run).not.toHaveBeenCalled();
  });
});

function repositoryRequest(commit: string) {
  return brokerEnvelope("repository", { operation: "snapshot-main", commit });
}

function commandRequest(query: string) {
  return brokerEnvelope("command", { operation: "search", arguments: { query } });
}

function repositoryBroker(snapshot: (...args: never[]) => Promise<unknown>) {
  return {
    operations: [{ operationId: "snapshot-main", remoteIdentity: "https://git.example/repo.git",
      commit: COMMIT, maxObjectBytes: 100, maxCheckoutBytes: 100, maxFiles: 10,
      pathPrefixes: ["src/"], submodules: "forbid" as const, lfs: "forbid" as const }],
    snapshot,
  };
}

async function compliantSnapshot() {
  return {
    snapshotToken: "snapshot-one", remoteIdentity: "https://git.example/repo.git",
    commit: COMMIT, treeDigest: digest("1"), objectBytes: 20, checkoutBytes: 30, fileCount: 2,
    submodules: "omitted" as const, lfs: "omitted" as const, hooksInstalled: false as const,
  };
}

async function dispatchWithCompletion(completion: { completed: number; attempted: number }) {
  const snapshot = vi.fn(async () => ({ ...(await compliantSnapshot()), completion }));
  const dispatcher = await setup({ repository: repositoryBroker(snapshot) });
  return dispatchHostBrokerRequest(dispatcher, repositoryRequest(COMMIT));
}

function commandBroker(run: (...args: never[]) => Promise<unknown>) {
  return {
    workingDirectoryToken: "cwd-invocation-tools",
    operations: [{ operationId: "search", targetIdentity: "registered-search",
      toolId: "registered-tool", executable: "/usr/bin/registered-tool",
      arguments: [{ name: "query", flag: "--query", type: "string" as const, maxStringBytes: 128 }],
      environment: { LANG: "C" }, timeoutMs: 1_000, maxAcceptedBytes: 1_024 }],
    run,
  };
}

function successfulCommandRun() {
  return vi.fn(async () => ({
    exitCode: 0, stdout: Buffer.from("ok"), stderr: Buffer.alloc(0),
  }));
}

async function setup(
  brokers: Record<string, unknown>,
  brokerMaximumOverrides?: Parameters<typeof prepareBrokerAuthority>[0]["brokerMaximumOverrides"],
) {
  const authority = [
    brokerAtom({ kind: "repository.snapshot", brokerId: "repository",
      operation: "snapshot-main", target: "https://git.example/repo.git" }),
    brokerAtom({ kind: "command.execute", brokerId: "command",
      operation: "search", target: "registered-search", toolId: "registered-tool" }),
  ];
  const fixture = trackFixture(await prepareBrokerAuthority({ authority, brokerMaximumOverrides }));
  return createHostBrokerDispatcher({
    paths: fixture.package.paths, authorityRequest: fixture.request,
    invocationId: parseInvocationId("invocation-tools"), brokers,
  });
}

function digest(character: string) {
  return parseSha256Digest(`sha256:${character.repeat(64)}`);
}

/**
 * @file test/artifacts/cli-artifact.test.ts
 * @description Real-subprocess tests for `artifact write` / `artifact verify`
 * over `dist/cli.js`. Drives the real CLI against a temp project root declaring
 * the `experiment-result` artifact type (see `test/fixtures/artifact-root.ts`),
 * exercising the grant gate, the exactly-one-body-source contract, the fail-
 * closed FIFO/invalid-UTF-8 body-file reads, and the no-declared-artifacts
 * `verify` refusal.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { access, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCLI, expectCLIExit, expectCLIFailure } from "../fixtures/run-cli.js";
import { makeResearchLikeRoot } from "../fixtures/artifact-root.js";
import { makeTempRoot } from "../fixtures/temp-root.js";
import { makeFifo } from "../fixtures/fifo.js";
import { hashArtifactBody, artifactPaths } from "../../src/artifacts/store.js";

const GRANT = { LLMWIKI_TRUSTED_WRITE: "*" };
const BODY = `{"accuracy":0.9}`;
const WRITE_ARGS = ["artifact", "write", "--type", "experiment-result", "--slug", "probe"];

let root = "";

beforeEach(async () => {
  root = await makeResearchLikeRoot("cli-artifact");
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("artifact write", () => {
  it("refuses without the grant, advising LLMWIKI_TRUSTED_WRITE, and writes nothing", async () => {
    const result = await runCLI([...WRITE_ARGS, "--body", BODY], root);
    expectCLIFailure(result);
    expect(result.stderr).toMatch(/LLMWIKI_TRUSTED_WRITE/);
    const { bytesPath } = artifactPaths(root, "experiment-result", "probe", "result.json");
    await expect(access(bytesPath)).rejects.toThrow();
  });

  it("applies live with the grant and prints the compact ref", async () => {
    const result = await runCLI([...WRITE_ARGS, "--body", BODY], root, GRANT);
    expectCLIExit(result, 0);
    expect(result.stdout.trim()).toBe(`experiment-result/probe@sha256:${hashArtifactBody(BODY)}`);
  });

  it("fails closed on a --body-file pointing at a FIFO (no hang)", async () => {
    const fifoPath = path.join(root, "body.fifo");
    await makeFifo(fifoPath);
    const result = await runCLI([...WRITE_ARGS, "--body-file", fifoPath], root, GRANT);
    expectCLIFailure(result);
  });

  it("rejects BOTH --body and --body-file with the exactly-one message", async () => {
    const bodyFile = path.join(root, "body.json");
    await writeFile(bodyFile, BODY, "utf8");
    const result = await runCLI([...WRITE_ARGS, "--body", BODY, "--body-file", bodyFile], root, GRANT);
    expectCLIFailure(result);
    expect(result.stderr).toMatch(/exactly one of --body or --body-file/);
  });

  it("rejects NEITHER --body nor --body-file with the same exactly-one message", async () => {
    const result = await runCLI(WRITE_ARGS, root, GRANT);
    expectCLIFailure(result);
    expect(result.stderr).toMatch(/exactly one of --body or --body-file/);
  });

  it("fails closed on invalid UTF-8 in --body-file, never a silent replacement-char write", async () => {
    const bodyFile = path.join(root, "invalid.json");
    await writeFile(bodyFile, Buffer.from([0x7b, 0xff, 0x7d]));
    const result = await runCLI([...WRITE_ARGS, "--body-file", bodyFile], root, GRANT);
    expectCLIFailure(result);
    expect(result.stderr).toMatch(/not valid UTF-8/);
  });
});

describe("artifact verify", () => {
  it("exits 1 with a dedicated message when no profile declares artifact types (not a dangling verdict)", async () => {
    const bareRoot = await makeTempRoot("cli-artifact-verify-no-profile");
    try {
      const result = await runCLI(
        ["artifact", "verify", "--type", "experiment-result", "--slug", "probe", "--sha256", "0".repeat(64)],
        bareRoot,
      );
      expectCLIFailure(result);
      expect(result.stderr).toMatch(/no artifact types declared/);
    } finally {
      await rm(bareRoot, { recursive: true, force: true });
    }
  });

  it("prints the health verdict for a written artifact", async () => {
    await runCLI([...WRITE_ARGS, "--body", BODY], root, GRANT);
    const result = await runCLI(
      ["artifact", "verify", "--type", "experiment-result", "--slug", "probe", "--sha256", hashArtifactBody(BODY)],
      root,
    );
    expectCLIExit(result, 0);
    expect(result.stdout).toMatch(/health:\s*ok/);
  });
});

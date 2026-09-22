/**
 * @file test/connectors/connector-cli-final6-rendering.test.ts
 * @description Final6 CLI regressions preserve exact SDK candidate identities
 * while terminal output uses bounded, reversible, one-line ASCII escapes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { connectorRunCommand } from "../../src/commands/connector.js";
import type { ConfinedFetchResult } from "../../src/connectors/confined-fetch.js";
import { runConnector, type RunConnectorResult } from "../../src/connectors/run.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import {
  FIXTURE_CONTENT_HASH,
  plantConnectorCandidate,
} from "./final6-fixtures.js";
import { activateFixtureConnector } from "./run-test-fixtures.js";

const root = useTempRoot();
const EXOTIC_ID = "candidate\u2028\u202e,part";

/** Return one deterministic offline fixture response. */
function fixtureFetch(): Promise<ConfinedFetchResult> {
  return Promise.resolve({
    kind: "ok",
    finalUrl: "https://fixture.local/story-1",
    bytes: Buffer.from("{}"),
    contentHash: FIXTURE_CONTENT_HASH,
  });
}

/** Capture physical console writes while running one connector command. */
async function captureCommand(runner: typeof runConnector): Promise<string[]> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line) => { lines.push(String(line)); });
  await connectorRunCommand("fixture", { input: ["id=story-1"] }, root.dir, { runner });
  return lines;
}

describe("Final6 connector CLI candidate rendering", () => {
  afterEach(() => {
    delete process.env.LLMWIKI_CONNECTORS;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("renders a production-selected control-bearing id as one reversible line", async () => {
    await activateFixtureConnector(root.dir);
    await plantConnectorCandidate(root.dir, EXOTIC_ID);
    let sdkResult: RunConnectorResult | undefined;
    const runner: typeof runConnector = async (runRoot, id, inputs) => {
      sdkResult = await runConnector(runRoot, id, inputs, { fetcher: fixtureFetch });
      return sdkResult;
    };

    const lines = await captureCommand(runner);
    const rendered = lines.join("\n");

    expect(sdkResult).toEqual({ kind: "noop", candidateIds: [EXOTIC_ID] });
    expect(lines).toHaveLength(1);
    expect(rendered).not.toContain("\u2028");
    expect(rendered).not.toContain("\u202e");
    expect(rendered).toContain("\\u2028");
    expect(rendered).toContain("\\u202e");
    expect(rendered).toContain("\\u002c");
    expect(process.exitCode).toBeUndefined();
  });

  it("uses the same encoding for recovery-required output", async () => {
    const runner = async () => ({
      kind: "recovery-required",
      candidateIds: [EXOTIC_ID],
    } as RunConnectorResult);

    const lines = await captureCommand(runner as typeof runConnector);
    const rendered = lines.join("\n");

    expect(lines).toHaveLength(1);
    expect(rendered).toContain("recovery-required");
    expect(rendered).toContain("\\u2028");
    expect(rendered).not.toContain("\u2028");
    expect(process.exitCode).toBe(1);
  });

  it("renders every identity in a public legacy 201-id result", async () => {
    const candidateIds = Array.from({ length: 201 }, (_, index) => `candidate-${index}`);
    const runner = async () => ({ kind: "noop", candidateIds } as RunConnectorResult);

    const lines = await captureCommand(runner as typeof runConnector);
    const rendered = lines.join("\n");

    expect(lines).toHaveLength(1);
    expect(rendered).toContain("noop: candidate-0, candidate-1");
    expect(rendered).toContain("candidate-200");
    expect(process.exitCode).not.toBe(1);
  });
});

/**
 * @file test/ask-no-mutation.test.ts
 * @description Public ordinary queries retain activity logging on CLI and MCP.
 * Their only allowed filesystem change without saving is log.md; opt-in scoped
 * reads retain the new read-only contract. This deliberately supersedes the
 * internal AS-1 default-no-log behavior to preserve public compatibility.
 *
 * THE MCP ROUTE IS EXERCISED, NOT INFERRED. Both surfaces call the same
 * `generateAnswer`, so it is tempting to test one and reason about the other —
 * but the gate could just as easily have been added at the CLI command, leaving
 * MCP writing silently. This captures the registered `query_wiki` handler and
 * invokes it, so the claim covers the surface it names.
 *
 * The control is an ALLOWLIST of changed paths — a denylist only refuses the
 * writes someone thought of — and it pins its own precondition so an empty
 * fingerprint cannot make it pass vacuously.
 */

import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { buildCollidingProject, echoCallClaudeModule, mockQueryVector } from "./fixtures/typed-grounding.js";
import { changedPaths as changed, fingerprintTree as fingerprint } from "./fixtures/tree-fingerprint.js";

vi.mock("../src/utils/llm.js", () => echoCallClaudeModule());

// THE MCP ROUTE GUARDS ON CREDENTIALS AND THE CLI ROUTE DOES NOT, so without
// this the MCP case measures whether the machine happens to have an API key
// rather than whether the query wrote anything — passing on a developer's
// machine and failing in CI, which is exactly what it did. The subject here is
// filesystem mutation; provider availability is a different claim with its own
// tests, so it is stubbed rather than depended on.
vi.mock("../src/utils/provider-guard.js", () => ({ ensureProviderAvailable: () => {} }));


/** A project with two same-slug pages, both retrievable. */
async function project(suffix: string): Promise<string> {
  const root = await buildCollidingProject(suffix, [1, 0], [0, 1]);
  mockQueryVector([1, 1]);
  return root;
}

/** Capture the MCP `query_wiki` handler by registering tools against a stub. */
async function mcpQueryHandler(root: string): Promise<(args: Record<string, unknown>) => Promise<unknown>> {
  const { registerWikiTools } = await import("../src/mcp/tools.js");
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    registerTool: (name: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  };
  registerWikiTools(server as never, root);
  const handler = handlers.get("query_wiki");
  if (handler === undefined) throw new Error(`query_wiki not registered; saw ${[...handlers.keys()].join(",")}`);
  return handler;
}

describe("asking a question without saving", () => {
  it("changes only the public activity log on the CLI route", async () => {
    const root = await project("ask-cli");
    const { generateAnswer } = await import("../src/commands/query.js");
    const before = await fingerprint(root);
    // Pins the precondition: an empty fingerprint would pass regardless.
    expect(before.size).toBeGreaterThan(0);

    await generateAnswer(root, "scaling?");

    expect(changed(before, await fingerprint(root))).toEqual(["log.md"]);
  });

  it("changes only the public activity log on the MCP route", async () => {
    const root = await project("ask-mcp");
    const handler = await mcpQueryHandler(root);
    const before = await fingerprint(root);
    expect(before.size).toBeGreaterThan(0);

    await handler({ question: "scaling?" });

    expect(changed(before, await fingerprint(root))).toEqual(["log.md"]);
  });

  it("keeps an explicitly scoped read byte-identical", async () => {
    const root = await project("ask-scoped");
    const { generateAnswer } = await import("../src/commands/query.js");
    const before = await fingerprint(root);
    expect(before.size).toBeGreaterThan(0);
    await generateAnswer(root, "scaling?", { pageScope: ["concepts/foo", "papers/foo"] });
    expect(changed(before, await fingerprint(root))).toEqual([]);
  });

  it("DOES journal when the answer is saved — the write path is unchanged", async () => {
    // Saving remains an explicit write as well as recording query activity.
    const root = await project("ask-saved");
    const { generateAnswer } = await import("../src/commands/query.js");
    const before = await fingerprint(root);

    await generateAnswer(root, "scaling?", { save: true });

    expect(changed(before, await fingerprint(root))).toContain("log.md");
  });
});

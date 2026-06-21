/**
 * Pending-target lint tests.
 *
 * Policy-held pages can be linked from live pages before approval. Those links
 * should be visible as informational `pending-target` diagnostics, not broken
 * wikilink errors, and they should not lower eval health.
 */

import { describe, it, expect } from "vitest";
import { lint } from "../src/linter/index.js";
import { evaluateHealth } from "../src/eval/health.js";
import { writeCandidate } from "../src/compiler/candidates.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";

const env = useLintTempRoot("pending-target-lint");

const LIVE_PAGE = [
  "---",
  "title: Live Page",
  "summary: Links to a pending page.",
  "sources: []",
  'createdAt: "2026-01-01T00:00:00.000Z"',
  'updatedAt: "2026-01-01T00:00:00.000Z"',
  "---",
  "",
  "This live page links to [[Pending Page]] while that page awaits review.",
  "Extra body text keeps the empty-page lint rule quiet.",
].join("\n");

/** Concept page linking to [[foo]] — used to probe typed-candidate suppression. */
const FOO_LINK_PAGE = [
  "---",
  "title: Foo Linker",
  "summary: Links to foo.",
  "sources: []",
  'createdAt: "2026-01-01T00:00:00.000Z"',
  'updatedAt: "2026-01-01T00:00:00.000Z"',
  "---",
  "",
  "This live page links to [[foo]] which has no resolvable page.",
  "Extra body text keeps the empty-page lint rule quiet.",
].join("\n");

describe("pending-target lint", () => {
  it("reports pending-target instead of broken-wikilink and does not penalize health", async () => {
    await env.writeConcept("live-page", LIVE_PAGE);
    await writeCandidate(env.dir, {
      title: "Pending Page",
      slug: "pending-page",
      summary: "Pending.",
      sources: [],
      body: "pending body",
      reviewMode: "policy",
      heldReasons: [{ code: "low-confidence" }],
    });

    const summary = await lint(env.dir);
    expect(summary.errors).toBe(0);
    expect(summary.results.map((r) => r.rule)).toContain("pending-target");
    expect(summary.results.map((r) => r.rule)).not.toContain("broken-wikilink");

    const health = await evaluateHealth(env.dir);
    const pending = health.rules.find((r) => r.rule === "pending-target");
    expect(pending?.deduction).toBe(0);
    expect(health.score).toBe(100);
  });

  it("does NOT suppress a broken wikilink for a TYPED pending candidate", async () => {
    await env.writeConcept("foo-linker", FOO_LINK_PAGE);
    await writeCandidate(env.dir, {
      title: "Foo",
      slug: "foo",
      summary: "Typed foo.",
      sources: [],
      body: "typed body",
      targetEntityType: "papers",
    });

    const summary = await lint(env.dir);
    expect(summary.results.map((r) => r.rule)).toContain("broken-wikilink");
    expect(summary.results.map((r) => r.rule)).not.toContain("pending-target");
  });

  it("still demotes a broken wikilink for a DEFAULT pending candidate", async () => {
    await env.writeConcept("foo-linker", FOO_LINK_PAGE);
    await writeCandidate(env.dir, {
      title: "Foo",
      slug: "foo",
      summary: "Default foo.",
      sources: [],
      body: "default body",
    });

    const summary = await lint(env.dir);
    expect(summary.results.map((r) => r.rule)).toContain("pending-target");
    expect(summary.results.map((r) => r.rule)).not.toContain("broken-wikilink");
  });
});


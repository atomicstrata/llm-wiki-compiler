/**
 * @file test/event-lint.test.ts
 * @description Tests for fail-closed EVENT-STORE lint (CLP 4b PR2) — making the
 * append-only, hash-chained audit log (`wiki/graph/events.jsonl`) tamper-VISIBLE
 * through the profile-aware lint runner.
 *
 * Covers: a HEALTHY chain (a couple of emitted events) yields NO event finding;
 * a TAMPERED chain (reorder / interior-edit / truncation) fails CLOSED into an
 * `event-chain-broken` error rather than passing silently; a torn trailing line
 * surfaces an `event-store-torn` warning (events before it still counted); a
 * too-new / symlinked / corrupt store fails closed into the matching store
 * finding instead of crashing lint; and a DEFAULT project plus an event-LESS
 * non-default project emit NO event findings (byte-identical default path).
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, appendFile, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { lint } from "../src/linter/index.js";
import { appendEvent } from "../src/events/store.js";
import { EVENTS_FILE, CONCEPTS_DIR } from "../src/utils/constants.js";
import { buildResearchLiteProject, buildResearchLiteRelationsProject } from "./fixtures/profile-fixtures.js";

let root = "";

/** Rule ids the event-store lint emits (chain-broken + torn + the three store-read codes). */
const EVENT_RULES = ["event-chain-broken", "event-store-torn", "event-store-corrupt", "event-store-too-new", "event-store-symlink"];

/** All lint findings emitted by the event-store check. */
async function eventFindings(): Promise<{ rule: string; severity: string; message: string }[]> {
  const { results } = await lint(root);
  return results.filter((r) => EVENT_RULES.includes(r.rule));
}

const storePath = (): string => path.join(root, EVENTS_FILE);
const evt = (n: string) => ({ type: "relation-create" as const, origin: "sdk", payload: { n }, at: "2024-01-01T00:00:00Z" });

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "event-lint-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("event lint — healthy chain", () => {
  it("emits no event finding for an intact chain of emitted events", async () => {
    await buildResearchLiteRelationsProject(root);
    await appendEvent(root, evt("a"));
    await appendEvent(root, evt("b"));
    const findings = await eventFindings();
    expect(findings).toHaveLength(0);
  });
});

describe("event lint — tamper detection (fail-closed)", () => {
  beforeEach(async () => await buildResearchLiteRelationsProject(root));

  it("flags event-chain-broken when interior records are reordered", async () => {
    await appendEvent(root, evt("a"));
    await appendEvent(root, evt("b"));
    await appendEvent(root, evt("c"));
    const [header, r1, r2, r3] = (await readFile(storePath(), "utf8")).split("\n").filter(Boolean);
    await writeFile(storePath(), [header, r2, r1, r3].join("\n") + "\n");
    const findings = await eventFindings();
    expect(findings.some((f) => f.rule === "event-chain-broken" && f.severity === "error")).toBe(true);
  });

  it("flags event-chain-broken when the log is truncated (head anchor mismatch)", async () => {
    await appendEvent(root, evt("a"));
    await appendEvent(root, evt("b"));
    const lines = (await readFile(storePath(), "utf8")).split("\n").filter(Boolean);
    await writeFile(storePath(), lines.slice(0, -1).join("\n") + "\n");
    const findings = await eventFindings();
    expect(findings.some((f) => f.rule === "event-chain-broken" && /head anchor/.test(f.message))).toBe(true);
  });

  it("fails closed to event-store-corrupt when an interior payload is edited", async () => {
    await appendEvent(root, evt("a"));
    await appendEvent(root, evt("b"));
    const raw = await readFile(storePath(), "utf8");
    await writeFile(storePath(), raw.replace('"n":"a"', '"n":"TAMPERED"'));
    const findings = await eventFindings();
    expect(findings.some((f) => f.rule === "event-store-corrupt" && f.severity === "error")).toBe(true);
  });
});

describe("event lint — torn / too-new / symlink (no crash)", () => {
  beforeEach(async () => await buildResearchLiteRelationsProject(root));

  it("surfaces a torn trailing line as an event-store-torn warning", async () => {
    await appendEvent(root, evt("a"));
    await appendFile(storePath(), '{"id":"evt_torn","type":"rel');
    const findings = await eventFindings();
    const torn = findings.filter((f) => f.rule === "event-store-torn");
    expect(torn).toHaveLength(1);
    expect(torn[0].severity).toBe("warning");
  });

  it("fails closed to event-store-too-new instead of crashing lint", async () => {
    await mkdir(path.dirname(storePath()), { recursive: true });
    await writeFile(storePath(), '{"kind":"event-store-header","schemaVersion":99}\n');
    const findings = await eventFindings();
    expect(findings.some((f) => f.rule === "event-store-too-new" && f.severity === "error")).toBe(true);
  });

  it("fails closed to event-store-symlink when the events leaf is a symlink", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "evt-leak-"));
    await mkdir(path.dirname(storePath()), { recursive: true });
    await writeFile(path.join(outside, "leak.jsonl"), "x");
    await symlink(path.join(outside, "leak.jsonl"), storePath());
    const findings = await eventFindings();
    expect(findings.some((f) => f.rule === "event-store-symlink" && f.severity === "error")).toBe(true);
    await rm(outside, { recursive: true, force: true });
  });
});

describe("event lint — no findings on default / event-less paths", () => {
  it("emits no event findings for a DEFAULT project (no wiki/graph)", async () => {
    await mkdir(path.join(root, CONCEPTS_DIR), { recursive: true });
    await writeFile(path.join(root, CONCEPTS_DIR, "foo.md"), "---\ntitle: Foo\n---\n\nbody body body body body.\n");
    const findings = await eventFindings();
    expect(findings).toHaveLength(0);
  });

  it("emits no event findings for an event-less non-default project", async () => {
    await buildResearchLiteProject(root);
    const findings = await eventFindings();
    expect(findings).toHaveLength(0);
  });
});

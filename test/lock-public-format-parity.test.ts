/**
 * Mixed-version lock records preserve public timestamp comparison and strict
 * runtime epoch identity. No legacy reader must interpret an epoch as ps text.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  classifyOwnerLiveness, isLockRecordStale, parseOwner, readProcessStartTime, serializeOwner,
} from "../src/utils/lock-owner.js";

/** Exact ambient rendering compared by baseline public lock readers. */
function legacyStart(): string {
  return execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)]).toString().trim();
}

describe("public lock record format", () => {
  it("writes the old reader field plus a preferred epoch for new readers", () => {
    const text = serializeOwner(process.pid);
    const wire = JSON.parse(text);
    expect(wire.startTime).toBe(legacyStart());
    expect(wire.identity).toBe(readProcessStartTime(process.pid));
    const owner = parseOwner(text)!;
    expect(owner.startTime).toBe(wire.identity);
    expect(classifyOwnerLiveness(owner)).toBe("live");
    expect(isLockRecordStale(owner)).toBe(false);
  });

  it("retains baseline reclamation for timestamp-only legacy records", () => {
    expect(isLockRecordStale({ pid: process.pid, startTime: legacyStart() })).toBe(false);
    const reused = { pid: process.pid, startTime: "Thu Jan 01 00:00:00 1970" };
    expect(isLockRecordStale(reused)).toBe(true);
    // New lease consumers must not accidentally acquire the legacy comparison.
    expect(classifyOwnerLiveness(reused)).toBe("unobservable-unrecognised");
  });

  it("prefers the epoch over stale legacy text and still detects epoch mismatch", () => {
    const owner = (identity: string) => parseOwner(JSON.stringify({
      pid: process.pid, startTime: "old ambient text", identity,
    }))!;
    expect(isLockRecordStale(owner(readProcessStartTime(process.pid)!))).toBe(false);
    expect(isLockRecordStale(owner("unix:1"))).toBe(true);
    expect(isLockRecordStale(owner("future:identity"))).toBe(false);
  });

  it("reads retained internal epoch-in-startTime records without changing lease format", () => {
    const owner = parseOwner(JSON.stringify({ pid: process.pid, startTime: readProcessStartTime(process.pid) }))!;
    expect(classifyOwnerLiveness(owner)).toBe("live");
    expect(isLockRecordStale(owner)).toBe(false);
  });
});

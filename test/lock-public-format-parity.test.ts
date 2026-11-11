/**
 * @file test/lock-public-format-parity.test.ts
 * @description The lock record carries only the epoch identity, and records in
 * the older ambient-timestamp format are judged by PID alone.
 */
import { describe, expect, it } from "bun:test";
import {
  classifyOwnerLiveness, isOwnerStale, parseOwner, readProcessStartTime, serializeOwner,
} from "../src/utils/lock-owner.js";

/** A PID no running process holds. */
const DEAD_PID = 999999;

describe("lock record format", () => {
  it("writes the pid and the epoch identity, nothing else", () => {
    const text = serializeOwner(process.pid);
    expect(JSON.parse(text)).toEqual({ pid: process.pid, identity: readProcessStartTime(process.pid) });
    const owner = parseOwner(text)!;
    expect(owner.startTime).toBe(owner.identity);
    expect(classifyOwnerLiveness(owner)).toBe("live");
  });

  it("never reclaims a timestamp-only record whose pid is alive, and reclaims it once the pid is dead", () => {
    const alive = { pid: process.pid, startTime: "Thu Jan 01 00:00:00 1970" };
    expect(classifyOwnerLiveness(alive)).toBe("unobservable-unrecognised");
    expect(isOwnerStale(alive)).toBe(false);
    expect(isOwnerStale({ pid: DEAD_PID, startTime: "Thu Jan 01 00:00:00 1970" })).toBe(true);
  });

  it("prefers the epoch over older timestamp text and still detects an epoch mismatch", () => {
    const owner = (identity: string) => parseOwner(JSON.stringify({
      pid: process.pid, startTime: "old ambient text", identity,
    }))!;
    expect(isOwnerStale(owner(readProcessStartTime(process.pid)!))).toBe(false);
    expect(isOwnerStale(owner("unix:1"))).toBe(true);
    expect(isOwnerStale(owner("future:identity"))).toBe(false);
  });
});

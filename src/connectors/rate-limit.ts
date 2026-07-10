/**
 * @file src/connectors/rate-limit.ts
 * @description Host-owned per-connector request-interval floor.
 *
 * The last-request timestamp is persisted under the project root and read/updated
 * under the project lock, so concurrent connector runs cannot both pass the
 * interval check. Reads route through the confined leaf reader and writes through
 * the confined atomic writer — a symlinked connectors directory fails closed.
 */

import path from "node:path";
import { atomicWrite } from "../utils/markdown.js";
import { acquireLock, releaseLock } from "../utils/lock.js";
import { readConfinedLeaf } from "../utils/confined-read.js";
import type { ConnectorRuntimeConfig } from "./config.js";
import type { RunConnectorResult } from "./run.js";

const RATE_STAMP_MAX_BYTES = 512;

/** Apply the configured request-interval floor before any external fetch. */
export async function enforceRequestInterval(
  root: string,
  connectorId: string,
  config: ConnectorRuntimeConfig,
  now?: () => Date,
): Promise<RunConnectorResult | null> {
  if (config.minRequestIntervalMs <= 0) return null;
  if (!(await acquireLock(root, { quiet: true }))) {
    return { kind: "unavailable", reason: "connector rate state locked" };
  }
  try {
    return await updateRateStampLocked(root, connectorId, config.minRequestIntervalMs, now);
  } finally {
    await releaseLock(root);
  }
}

/** Read/update the connector's last-request timestamp while the project lock is held. */
async function updateRateStampLocked(
  root: string,
  connectorId: string,
  minIntervalMs: number,
  now?: () => Date,
): Promise<RunConnectorResult | null> {
  const stamp = await readRateStamp(root, connectorId);
  if (stamp.kind === "unavailable") return stamp;
  const current = (now ? now() : new Date()).getTime();
  if (stamp.kind === "ok" && current - stamp.atMs < minIntervalMs) {
    return { kind: "refused", reason: "connector minimum request interval has not elapsed" };
  }
  try {
    await writeRateStamp(root, connectorId, current);
  } catch {
    return { kind: "unavailable", reason: "connector rate state unavailable" };
  }
  return null;
}

/** Read the prior connector request timestamp, preserving unavailable as fail-closed. */
async function readRateStamp(
  root: string,
  connectorId: string,
): Promise<{ kind: "ok"; atMs: number } | { kind: "absent" } | { kind: "unavailable"; reason: string }> {
  const file = rateStampPath(root, connectorId);
  const read = await readConfinedLeaf(root, file, path.dirname(file), RATE_STAMP_MAX_BYTES);
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind === "unavailable") return { kind: "unavailable", reason: "connector rate state unavailable" };
  return parseRateStamp(read.body);
}

/** Parse the persisted rate timestamp. */
function parseRateStamp(raw: string): { kind: "ok"; atMs: number } | { kind: "unavailable"; reason: string } {
  try {
    const parsed = JSON.parse(raw) as { atMs?: unknown };
    if (typeof parsed.atMs === "number" && Number.isSafeInteger(parsed.atMs)) return { kind: "ok", atMs: parsed.atMs };
  } catch {
    // handled below
  }
  return { kind: "unavailable", reason: "connector rate state corrupt" };
}

/** Persist the current connector request timestamp under the project root. */
async function writeRateStamp(root: string, connectorId: string, atMs: number): Promise<void> {
  const file = rateStampPath(root, connectorId);
  await atomicWrite(file, `${JSON.stringify({ atMs })}\n`, { confineRoot: root });
}

/** The host-owned request-interval marker for one connector. */
function rateStampPath(root: string, connectorId: string): string {
  return path.join(root, ".llmwiki", "connectors", `${connectorId}.last-fetch.json`);
}

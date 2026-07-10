/**
 * @file src/connectors/config.ts
 * @description Connector activation and tighten-only etiquette config.
 *
 * Connector activation is intentionally out-of-workspace: the operator opts in
 * with `LLMWIKI_CONNECTORS`, not a profile or project file an agent can edit.
 * Project-local `.llmwiki/config.json` may only tighten connector etiquette
 * floors such as allowed hosts and request interval; it cannot activate a
 * connector or widen the first-party registry allowlist.
 */

import path from "node:path";
import { MAX_LOCAL_CONFIG_BYTES } from "../utils/constants.js";
import { readCappedNoFollow } from "../utils/confined-read.js";
import { resolveExistingConfinedPrivateDir } from "../utils/private-dir.js";

const CONNECTORS_ENV = "LLMWIKI_CONNECTORS";
const CONTACT_RE = /^[A-Za-z0-9._%+\-@]+$/;

/** Runtime connector config after applying registry floors and local tightening. */
export interface ConnectorRuntimeConfig {
  /** Optional operator contact used by polite connector User-Agent injection. */
  contactEmail?: string;
  /** Minimum milliseconds between connector requests; local config can only raise this floor. */
  minRequestIntervalMs: number;
  /** Exact allowed hosts; local config can only choose a subset of the registry hosts. */
  allowedHosts: string[];
}

/** Trust-aware result for reading one connector's local config. */
export type ConnectorConfigRead =
  | { kind: "ok"; config: ConnectorRuntimeConfig }
  | { kind: "absent"; config: ConnectorRuntimeConfig }
  | { kind: "unavailable"; reason: string };

interface ProjectConnectorConfig {
  connectors?: Record<string, unknown>;
}

/** Return true only when the operator's out-of-workspace env var names `id`. */
export function isConnectorActivated(id: string): boolean {
  const raw = process.env[CONNECTORS_ENV];
  if (typeof raw !== "string" || raw.length === 0) return false;
  return raw.split(/[\s,]+/).filter(Boolean).includes(id);
}

/**
 * Load `.llmwiki/config.json` for one connector.
 *
 * Absent config returns registry defaults. Present but malformed/untrusted config
 * is `unavailable`, so the caller can refuse rather than silently widening a
 * connector's egress or header surface.
 */
export async function loadConnectorConfig(
  root: string,
  id: string,
  registryHosts: readonly string[],
  defaultMinIntervalMs: number,
): Promise<ConnectorConfigRead> {
  const base = defaultConnectorConfig(registryHosts, defaultMinIntervalMs);
  const read = await readProjectConfig(root);
  if (read.kind === "absent") return { kind: "absent", config: base };
  if (read.kind === "unavailable") return read;
  const entry = read.config.connectors?.[id];
  if (entry === undefined) return { kind: "absent", config: base };
  const parsed = parseConnectorEntry(entry, base, registryHosts);
  return parsed.kind === "ok" ? { kind: "ok", config: parsed.config } : parsed;
}

/** Build the registry-derived config floor before any local tightening. */
function defaultConnectorConfig(hosts: readonly string[], minRequestIntervalMs: number): ConnectorRuntimeConfig {
  return { minRequestIntervalMs, allowedHosts: [...hosts] };
}

/** Read and parse the project-local connector config leaf without creating `.llmwiki`. */
async function readProjectConfig(
  root: string,
): Promise<{ kind: "ok"; config: ProjectConnectorConfig } | { kind: "absent" } | { kind: "unavailable"; reason: string }> {
  const privateDir = await resolvePrivateDir(root);
  if (privateDir.kind !== "ok") return privateDir;
  const read = await readCappedNoFollow(path.join(privateDir.dir, "config.json"), MAX_LOCAL_CONFIG_BYTES);
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind === "unavailable") return { kind: "unavailable", reason: "config-unavailable" };
  return parseProjectConfig(read.body);
}

/** Resolve the existing private dir, mapping confinement failures into `unavailable`. */
async function resolvePrivateDir(root: string): Promise<{ kind: "ok"; dir: string } | { kind: "absent" } | { kind: "unavailable"; reason: string }> {
  try {
    const dir = await resolveExistingConfinedPrivateDir(root);
    return dir === null ? { kind: "absent" } : { kind: "ok", dir };
  } catch {
    return { kind: "unavailable", reason: "config-dir-unavailable" };
  }
}

/** Parse the project config JSON, accepting configs with no connector section. */
function parseProjectConfig(raw: string): { kind: "ok"; config: ProjectConnectorConfig } | { kind: "unavailable"; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unavailable", reason: "config-corrupt" };
  }
  if (!isPlainObject(parsed)) return { kind: "unavailable", reason: "config-schema" };
  if (parsed.connectors !== undefined && !isPlainObject(parsed.connectors)) {
    return { kind: "unavailable", reason: "connectors-schema" };
  }
  return { kind: "ok", config: parsed as ProjectConnectorConfig };
}

/** Parse and tighten one connector entry. */
function parseConnectorEntry(
  entry: unknown,
  base: ConnectorRuntimeConfig,
  registryHosts: readonly string[],
): { kind: "ok"; config: ConnectorRuntimeConfig } | { kind: "unavailable"; reason: string } {
  if (!isPlainObject(entry)) return { kind: "unavailable", reason: "connector-schema" };
  const email = parseContactEmail(entry.contactEmail);
  if (email.kind !== "ok") return email;
  const interval = parseMinInterval(entry.minRequestIntervalMs, base.minRequestIntervalMs);
  if (interval.kind !== "ok") return interval;
  const hosts = parseAllowedHosts(entry.allowedHosts, registryHosts);
  if (hosts.kind !== "ok") return hosts;
  return { kind: "ok", config: { contactEmail: email.value, minRequestIntervalMs: interval.value, allowedHosts: hosts.value } };
}

/** Validate the optional contact email for safe header insertion. */
function parseContactEmail(value: unknown): { kind: "ok"; value?: string } | { kind: "unavailable"; reason: string } {
  if (value === undefined) return { kind: "ok" };
  if (typeof value !== "string" || !CONTACT_RE.test(value)) return { kind: "unavailable", reason: "contact-email-invalid" };
  return { kind: "ok", value };
}

/** Apply the registry request-interval floor; local config can only raise it. */
function parseMinInterval(value: unknown, floor: number): { kind: "ok"; value: number } | { kind: "unavailable"; reason: string } {
  if (value === undefined) return { kind: "ok", value: floor };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return { kind: "unavailable", reason: "min-interval-invalid" };
  }
  return { kind: "ok", value: Math.max(value, floor) };
}

/** Validate allowed hosts as an exact subset of the first-party registry allowlist. */
function parseAllowedHosts(value: unknown, registryHosts: readonly string[]): { kind: "ok"; value: string[] } | { kind: "unavailable"; reason: string } {
  if (value === undefined) return { kind: "ok", value: [...registryHosts] };
  if (!Array.isArray(value) || !value.every((host) => typeof host === "string")) {
    return { kind: "unavailable", reason: "allowed-hosts-invalid" };
  }
  const registry = new Set(registryHosts);
  if (!value.every((host) => registry.has(host))) return { kind: "unavailable", reason: "allowed-hosts-widen" };
  return { kind: "ok", value: [...value] };
}

/** True only for non-null, non-array objects. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

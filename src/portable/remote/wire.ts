/**
 * @file src/portable/remote/wire.ts
 * @description The wire form shared by the simulated host and its client: the
 * closed list of methods a client may name, and how bytes travel in JSON.
 *
 * A client sends a credential, a method name from this list and the caller's
 * own arguments. It sends no principal, role, label with authority, read-set,
 * plan, fence or pre-image, and the host accepts none.
 */

/** Every method a remote client may call. Anything else is not found. */
const REMOTE_METHODS = [
  "session", "capabilities", "allocateOperation",
  "pages.get", "pages.list", "sources.get", "sources.add",
  "propose", "candidates.list", "candidates.get", "candidates.approve", "approvals.get",
  "apply", "status", "resolve", "issueExecutionTicket", "search", "export", "deferred",
] as const;

/** One of the closed remote methods. */
export type RemoteMethod = (typeof REMOTE_METHODS)[number];

const BYTES_KEY = "$bytes";

/** Encode a value for JSON, turning byte arrays into tagged base64. */
export function encodeWire(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [BYTES_KEY]: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(encodeWire);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeWire(entry)]));
  }
  return value;
}

/** Decode a value from JSON, restoring tagged base64 to byte arrays. */
export function decodeWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeWire);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record[BYTES_KEY] === "string" && Object.keys(record).length === 1) {
    return new Uint8Array(Buffer.from(record[BYTES_KEY], "base64"));
  }
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, decodeWire(entry)]));
}

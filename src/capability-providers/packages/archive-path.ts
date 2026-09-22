/**
 * @file src/capability-providers/packages/archive-path.ts
 * @description Portable provider archive path admission shared by extraction and verification.
 */
import path from "node:path";

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Validate one portable archive entry name and return canonical components. */
export function validateProviderArchivePath(value: string): readonly string[] {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 4096
    || value.includes("\\") || value.includes("\0")) throw archivePathError();
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw archivePathError();
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  const parts = normalized.split("/");
  if (parts.length < 1 || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw archivePathError();
  }
  const canonical = parts.map((part) => part.normalize("NFC"));
  if (canonical.some((part) => Buffer.byteLength(part) > 255
    || !/^[A-Za-z0-9._-]+$/.test(part) || part.endsWith(".")
    || WINDOWS_DEVICE.test(part) || part !== part.trim())) throw archivePathError();
  return Object.freeze(canonical);
}

function archivePathError(): Error {
  return new Error("provider archive path is unsafe");
}

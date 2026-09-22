/**
 * @file src/capability-providers/authority/credential-sources.ts
 * @description Closed host credential-source adapters. Environment and macOS
 * keychain lookups happen only at broker-use time, never in readiness, status,
 * provider environment, or a provider-supplied callback.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CredentialSourceDescriptorV1 } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_SECRET_BYTES = 64 * 1024;
const KEYCHAIN_TIMEOUT_MS = 10_000;

/** Read one credential value through the closed adapter selected by its descriptor. */
export async function loadCredentialSourceBytes(
  source: CredentialSourceDescriptorV1,
): Promise<Buffer> {
  try {
    const value = source.kind === "environment"
      ? environmentValue(source.variable)
      : await keychainValue(source.service, source.account);
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length === 0 || bytes.length > MAX_SECRET_BYTES) throw credentialSourceError();
    return bytes;
  } catch { throw credentialSourceError(); }
}

function environmentValue(variable: string): string {
  const value = process.env[variable];
  if (typeof value !== "string" || value.length === 0) throw credentialSourceError();
  return value;
}

async function keychainValue(service: string, account: string): Promise<string> {
  if (process.platform !== "darwin") throw credentialSourceError();
  const result = await execFileAsync(
    "/usr/bin/security", ["find-generic-password", "-w", "-s", service, "-a", account],
    { encoding: "utf8", maxBuffer: MAX_SECRET_BYTES, timeout: KEYCHAIN_TIMEOUT_MS },
  );
  const stdout = result.stdout;
  if (typeof stdout !== "string") throw credentialSourceError();
  return stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
}

function credentialSourceError(): Error {
  return new Error("provider credential source is unavailable");
}

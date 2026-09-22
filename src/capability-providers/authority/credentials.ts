/**
 * @file src/capability-providers/authority/credentials.ts
 * @description Opaque credential handle registry, exact broker-bound one-use
 * leases, and fail-closed reflection scanning for every provider-visible
 * surface. Registry state contains descriptors only, never secret values.
 */
import path from "node:path";
import { TextDecoder } from "node:util";
import { atomicWrite } from "../../utils/atomic-write.js";
import {
  captureDenseArray, captureExactRecord, captureOwnDataRecord,
} from "../../utils/runtime-capture.js";
import { isWellFormedUnicode } from "../../utils/well-formed-unicode.js";
import { parseBoundedUniqueJson } from "../../profile/templates/signing/json.js";
import { parseBrokerId } from "../ids.js";
import type { AuthorizedProviderPaths } from "../packages/paths.js";
import { withProviderStateLock } from "../packages/state-store.js";
import type { BrokerIdV1 } from "../types.js";
import { loadCredentialSourceBytes } from "./credential-sources.js";
import { readProviderAuthorityText } from "./grants-store.js";
import type {
  CredentialAccessV1, CredentialHandleV1, CredentialRegistryStateReadV1, CredentialRegistryV1,
  CredentialSourceDescriptorV1, ProviderVisibleCredentialSurfacesV1,
} from "./types.js";

const MAX_CREDENTIAL_HANDLES = 1_024;
const MAX_BROKERS_PER_HANDLE = 128;
const MAX_SURFACE_ITEMS = 4_096;
const MAX_TEXT_BYTES = 4_096;
const MAX_REFLECTION_SURFACE_BYTES = 8 * 1024 * 1024;
const MAX_VISIBLE_SURFACE_ITEM_BYTES = MAX_REFLECTION_SURFACE_BYTES;
const MAX_REFLECTION_WORK_BYTES = 64 * 1024 * 1024;
const MAX_CREDENTIAL_STATE_BYTES = 4 * 1024 * 1024;
const CREDENTIALS_FILENAME = "provider-credentials-v1.json";
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const HANDLE_KEYS = Object.freeze(["schemaVersion", "handleId", "slotId", "source", "allowedBrokerIds"] as const);
const SURFACE_KEYS = Object.freeze([
  "urls", "headers", "errors", "status", "frames", "stdout", "stderr", "receipts", "retainedEvidence",
] as const satisfies readonly (keyof ProviderVisibleCredentialSurfacesV1)[]);
const accessSecrets = new WeakMap<object, { readonly brokerId: BrokerIdV1; readonly bytes: Buffer }>();

/** Capture a closed descriptor-only registry, rejecting duplicates and unknown sources. */
export function createCredentialRegistry(handles: readonly CredentialHandleV1[]): CredentialRegistryV1 {
  try {
    const snapshot = captureDenseArray(handles, MAX_CREDENTIAL_HANDLES, parseHandle, credentialError);
    const registry = Object.create(null) as Record<string, CredentialHandleV1>;
    for (const handle of snapshot) {
      if (registry[handle.handleId]) throw credentialError();
      registry[handle.handleId] = handle;
    }
    return Object.freeze({ schemaVersion: 1, handles: Object.freeze(registry) });
  } catch { throw credentialError(); }
}

/** Read descriptor-only operator credential state without resolving secrets. */
export async function readCredentialRegistryState(
  paths: AuthorizedProviderPaths,
): Promise<CredentialRegistryStateReadV1> {
  const read = await readProviderAuthorityText(
    paths, CREDENTIALS_FILENAME, MAX_CREDENTIAL_STATE_BYTES,
  );
  if (read.kind !== "ok") return read;
  try { return Object.freeze({ kind: "ok", registry: parseCredentialRegistry(read.text) }); }
  catch { return Object.freeze({ kind: "invalid" }); }
}

/** Strictly replace descriptor-only credential state under the provider lock. */
export async function writeOperatorCredentialRegistry(
  paths: AuthorizedProviderPaths,
  registry: CredentialRegistryV1,
): Promise<void> {
  const snapshot = snapshotRegistry(registry);
  await withProviderStateLock(paths, async () => {
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_CREDENTIAL_STATE_BYTES) throw credentialError();
    parseCredentialRegistry(text);
    await atomicWrite(path.join(paths.configRoot, CREDENTIALS_FILENAME), text, {
      confineRoot: paths.configRoot, exactParent: true, durable: true,
      strictDurability: true, mode: 0o600,
    });
  });
}

/** Verify one local handle is the exact mapping for a logical slot and broker. */
export function assertCredentialHandleBinding(
  registry: CredentialRegistryV1,
  slotId: string,
  handleId: string,
  brokerId: BrokerIdV1,
): CredentialHandleV1 {
  const snapshot = snapshotRegistry(registry);
  const handle = snapshot.handles[token(handleId)];
  const safeSlotId = token(slotId), safeBrokerId = parseBrokerId(brokerId);
  if (!handle || handle.slotId !== safeSlotId || !handle.allowedBrokerIds.includes(safeBrokerId)) {
    throw credentialMissingError();
  }
  return handle;
}

/** Resolve one descriptor and read its secret only for the exact requesting broker. */
export async function resolveCredentialHandle(
  registry: CredentialRegistryV1,
  slotId: string,
  handleId: string,
  brokerId: BrokerIdV1,
): Promise<CredentialAccessV1> {
  const safeBrokerId = parseBrokerId(brokerId);
  const handle = assertCredentialHandleBinding(registry, slotId, handleId, safeBrokerId);
  const bytes = await loadCredentialSourceBytes(handle.source);
  const access = Object.freeze({
    handleId: handle.handleId, slotId: handle.slotId,
    brokerId: safeBrokerId, sourceKind: handle.source.kind,
  }) as CredentialAccessV1;
  accessSecrets.set(access, { brokerId: safeBrokerId, bytes });
  return access;
}

/** Materialize a one-use secret only to the same exact host broker. */
export async function takeCredentialBytesForBroker(
  access: CredentialAccessV1,
  brokerId: BrokerIdV1,
): Promise<Buffer> {
  const stored = accessSecrets.get(access);
  const safeBrokerId = parseBrokerId(brokerId);
  if (!stored || stored.brokerId !== safeBrokerId) throw credentialSourceError();
  accessSecrets.delete(access);
  const result = Buffer.from(stored.bytes);
  stored.bytes.fill(0);
  return result;
}

/** Refuse any supported representation of a secret on a provider-visible surface. */
export function assertNoCredentialReflection(
  credentials: readonly Buffer[],
  surfaces: ProviderVisibleCredentialSurfacesV1,
): void {
  try {
    const capturedSurfaces = captureExactRecord(surfaces, SURFACE_KEYS);
    const secrets = captureDenseArray(credentials, 128, captureSecret, reflectionError);
    const surfaceViews = captureSurfaceViews(capturedSurfaces, secrets.length);
    for (const secret of secrets) {
      const variants = secretVariants(secret);
      if (surfaceViews.some((views) => containsSecretVariant(views, variants))) throw reflectionError();
    }
  } catch { throw reflectionError(); }
}

function snapshotRegistry(registry: CredentialRegistryV1): CredentialRegistryV1 {
  const value = captureExactRecord(registry, ["schemaVersion", "handles"]);
  if (value.schemaVersion !== 1) throw credentialError();
  const handles = captureOwnDataRecord(value.handles);
  if (Object.keys(handles).length > MAX_CREDENTIAL_HANDLES) throw credentialError();
  for (const [handleId, handle] of Object.entries(handles)) {
    if (parseHandle(handle).handleId !== handleId) throw credentialError();
  }
  return createCredentialRegistry(Object.values(handles) as CredentialHandleV1[]);
}

function parseCredentialRegistry(text: string): CredentialRegistryV1 {
  const value = captureExactRecord(
    parseBoundedUniqueJson(text, MAX_CREDENTIAL_STATE_BYTES), ["schemaVersion", "handles"],
  );
  if (value.schemaVersion !== 1) throw credentialError();
  const handles = captureOwnDataRecord(value.handles);
  if (Object.keys(handles).length > MAX_CREDENTIAL_HANDLES) throw credentialError();
  return createCredentialRegistry(Object.entries(handles).map(([handleId, handle]) => {
    const parsed = parseHandle(handle);
    if (parsed.handleId !== handleId) throw credentialError();
    return parsed;
  }));
}

function parseHandle(value: unknown): CredentialHandleV1 {
  const handle = captureExactRecord(value, HANDLE_KEYS);
  if (handle.schemaVersion !== 1) throw credentialError();
  const brokers = captureDenseArray(handle.allowedBrokerIds, MAX_BROKERS_PER_HANDLE,
    (broker) => parseBrokerId(broker), credentialError);
  if (new Set(brokers).size !== brokers.length || brokers.length === 0) throw credentialError();
  return Object.freeze({
    schemaVersion: 1, handleId: token(handle.handleId), slotId: token(handle.slotId),
    source: parseSource(handle.source), allowedBrokerIds: brokers,
  });
}

function parseSource(value: unknown): CredentialSourceDescriptorV1 {
  const kind = captureOwnDataRecord(value).kind;
  if (kind === "environment") {
    const source = captureExactRecord(value, ["kind", "variable"]);
    return Object.freeze({ kind, variable: environmentVariable(source.variable) });
  }
  if (kind === "os-keychain") {
    const source = captureExactRecord(value, ["kind", "service", "account"]);
    return Object.freeze({ kind, service: boundedText(source.service), account: boundedText(source.account) });
  }
  throw credentialError();
}

/** Capture decoded surfaces once under aggregate byte and scan-work budgets. */
function captureSurfaceViews(
  value: Readonly<Record<string, unknown>>,
  secretCount: number,
): readonly (readonly Buffer[])[] {
  let surfaceBytes = 0;
  const views: (readonly Buffer[])[] = [];
  for (const key of SURFACE_KEYS) {
    const captured = captureDenseArray(value[key], MAX_SURFACE_ITEMS, (item) => {
      const bytes = captureVisibleBytes(item);
      surfaceBytes += bytes.length;
      if (surfaceBytes > MAX_REFLECTION_SURFACE_BYTES
        || surfaceBytes * secretCount > MAX_REFLECTION_WORK_BYTES) throw reflectionError();
      return decodedViews(bytes);
    }, reflectionError);
    views.push(...captured);
  }
  return Object.freeze(views);
}

function captureVisibleBytes(value: unknown): Buffer {
  if (typeof value === "string") {
    if (!isWellFormedUnicode(value)
      || Buffer.byteLength(value) > MAX_VISIBLE_SURFACE_ITEM_BYTES) throw reflectionError();
    return Buffer.from(value, "utf8");
  }
  if (!(value instanceof Uint8Array)
    || value.byteLength > MAX_VISIBLE_SURFACE_ITEM_BYTES) throw reflectionError();
  return Buffer.from(value);
}

function captureSecret(value: unknown): Buffer {
  if (!Buffer.isBuffer(value) || value.length === 0 || value.length > 64 * 1024) throw reflectionError();
  return Buffer.from(value);
}

interface SecretVariants {
  readonly exact: readonly Buffer[];
  readonly hexLower: Buffer;
  readonly percentCanonical: readonly Buffer[];
}

function secretVariants(secret: Buffer): SecretVariants {
  const base64 = secret.toString("base64");
  const base64UrlPadded = base64.replaceAll("+", "-").replaceAll("/", "_");
  const textEncodings = standardTextEncodings(secret);
  const exact = uniqueBuffers([
    secret, Buffer.from(base64), Buffer.from(base64.replace(/=+$/, "")),
    Buffer.from(base64UrlPadded), Buffer.from(base64UrlPadded.replace(/=+$/, "")),
    ...textEncodings,
  ]);
  return Object.freeze({
    exact, hexLower: Buffer.from(secret.toString("hex")),
    percentCanonical: uniqueBuffers([
      Buffer.from(percentEveryByte(secret)), ...textEncodings.map(canonicalPercentEscapes),
    ]),
  });
}

function containsSecretVariant(surfaceViews: readonly Buffer[], variants: SecretVariants): boolean {
  return surfaceViews.some((view) => containsSecretInView(view, variants));
}

function containsSecretInView(surface: Buffer, variants: SecretVariants): boolean {
  if (variants.exact.some((variant) => surface.indexOf(variant) !== -1)) return true;
  if (asciiLower(surface).indexOf(variants.hexLower) !== -1) return true;
  const canonical = canonicalPercentEscapes(surface);
  return variants.percentCanonical.some((variant) => canonical.indexOf(variant) !== -1);
}

function decodedViews(surface: Buffer): readonly Buffer[] {
  return uniqueBuffers([surface, decodePercentLayer(surface, false), decodePercentLayer(surface, true)]);
}

function decodePercentLayer(value: Buffer, form: boolean): Buffer {
  const decoded: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const byte = value[index];
    if (byte === 0x25 && isHexByte(value[index + 1]) && isHexByte(value[index + 2])) {
      decoded.push(Number.parseInt(String.fromCharCode(value[index + 1], value[index + 2]), 16));
      index += 2;
    } else decoded.push(form && byte === 0x2b ? 0x20 : byte);
  }
  return Buffer.from(decoded);
}

function isHexByte(value: number | undefined): value is number {
  return value !== undefined && (value >= 0x30 && value <= 0x39
    || value >= 0x41 && value <= 0x46 || value >= 0x61 && value <= 0x66);
}

function standardTextEncodings(secret: Buffer): readonly Buffer[] {
  try {
    const text = STRICT_UTF8.decode(secret);
    return [Buffer.from(encodeURIComponent(text)), Buffer.from(formEncode(text))];
  } catch { return []; }
}

function formEncode(value: string): string {
  return new URLSearchParams([["value", value]]).toString().slice("value=".length);
}

function percentEveryByte(value: Buffer): string {
  return [...value].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
}

function canonicalPercentEscapes(value: Buffer): Buffer {
  const result = Buffer.from(value);
  for (let index = 0; index + 2 < result.length; index += 1) {
    if (result[index] !== 0x25) continue;
    result[index + 1] = lowerHex(result[index + 1]);
    result[index + 2] = lowerHex(result[index + 2]);
  }
  return result;
}

function lowerHex(value: number): number {
  return value >= 0x41 && value <= 0x46 ? value + 0x20 : value;
}

function asciiLower(value: Buffer): Buffer {
  return Buffer.from(value.map((byte) => byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte));
}

function uniqueBuffers(values: readonly Buffer[]): readonly Buffer[] {
  const seen = new Set<string>();
  return Object.freeze(values.filter((value) => {
    const key = value.toString("hex");
    if (value.length === 0 || seen.has(key)) return false;
    seen.add(key); return true;
  }).map((value) => Buffer.from(value)));
}

function environmentVariable(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value)) throw credentialError();
  return value;
}
function token(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw credentialError();
  return value;
}
function boundedText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !isWellFormedUnicode(value)
    || Buffer.byteLength(value) > MAX_TEXT_BYTES) throw credentialError();
  return value;
}
function credentialError(): Error { return new Error("provider credential registry is invalid"); }
function credentialMissingError(): Error { return new Error("provider credential is missing"); }
function credentialSourceError(): Error { return new Error("provider credential source is unavailable"); }
function reflectionError(): Error { return new Error("credential reflection detected"); }

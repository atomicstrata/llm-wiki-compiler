/**
 * @file src/profile/templates/publish/tap-key-file.ts
 * @description Path-bound, bounded, canonical public-key file selection for
 * offline publisher verification with stable path-free failures.
 */
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { decodeUtf8, readBoundedFromHandle } from "./bounded-read.js";
import {
  assertPathMatchesHandle,
  identity,
  openDirectoryNoFollow,
  sameIdentity,
} from "./distribution-paths.js";

const MAX_KEY_BYTES = 16 * 1024;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** One tap-key selection retained for the complete verification transaction. */
export interface SelectedTapPublicKey {
  read(): Promise<string>;
  readBytes(): Promise<Buffer>;
  close(): Promise<void>;
}

/** Anchor the selected key leaf and canonical parent before reading bytes. */
export async function openTapPublicKey(file: string): Promise<SelectedTapPublicKey> {
  const selected = path.resolve(file);
  const leaf = await lstat(selected).catch(() => null);
  if (!leaf || leaf.isSymbolicLink()) throw new Error("tap key file is unavailable, symlinked, or special");
  const canonical = await realpath(selected).catch(() => null);
  if (!canonical) throw new Error("tap key file is unavailable, symlinked, or special");
  const parentPath = path.dirname(canonical);
  const parentHandle = await openDirectoryNoFollow(parentPath).catch(() => null);
  if (!parentHandle) throw new Error("tap key parent cannot be anchored");
  try {
    return await openSelectedKey(selected, canonical, parentPath, parentHandle);
  } catch (error) {
    await parentHandle.close().catch(() => {});
    if (error instanceof Error && error.message.startsWith("tap key ")) throw error;
    throw new Error("tap key file could not be opened safely");
  }
}

async function openSelectedKey(
  selected: string,
  canonical: string,
  parentPath: string,
  parentHandle: FileHandle,
): Promise<SelectedTapPublicKey> {
  const parentInfo = await parentHandle.stat();
  if (!parentInfo.isDirectory()) throw new Error("tap key parent cannot be anchored");
  const handle = await open(
    canonical,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("tap key file must be a regular file and not a symlink or special file");
    await assertSelectedTapKey(selected, canonical, parentPath, parentInfo, handle, info);
    return selectedKey(selected, canonical, parentPath, parentInfo, parentHandle, handle, info);
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function selectedKey(
  selected: string,
  canonical: string,
  parentPath: string,
  parentInfo: Stats,
  parentHandle: FileHandle,
  handle: FileHandle,
  info: Stats,
): SelectedTapPublicKey {
  return {
    read: async () => readSelectedTapKey(selected, canonical, parentPath, parentInfo, handle, info),
    readBytes: async () => readSelectedTapKeyBytes(
      selected, canonical, parentPath, parentInfo, handle, info,
    ),
    close: async () => {
      await handle.close().catch(() => {});
      await parentHandle.close().catch(() => {});
    },
  };
}

async function readSelectedTapKey(
  selected: string,
  canonical: string,
  parentPath: string,
  parentInfo: Stats,
  handle: FileHandle,
  info: Stats,
): Promise<string> {
  const bytes = await readSelectedTapKeyBytes(
    selected, canonical, parentPath, parentInfo, handle, info,
  );
  return decodeTapPublicKey(bytes);
}

/** Read the retained key as exact bytes while reasserting its path binding. */
async function readSelectedTapKeyBytes(
  selected: string,
  canonical: string,
  parentPath: string,
  parentInfo: Stats,
  handle: FileHandle,
  info: Stats,
): Promise<Buffer> {
  try {
    await assertSelectedTapKey(selected, canonical, parentPath, parentInfo, handle, info);
    const bytes = await readBoundedFromHandle(handle, MAX_KEY_BYTES, "tap key file");
    await assertSelectedTapKey(selected, canonical, parentPath, parentInfo, handle, info);
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("tap key ")) throw error;
    throw new Error("tap key file could not be read safely");
  }
}

async function assertSelectedTapKey(
  selected: string,
  canonical: string,
  parentPath: string,
  parentInfo: Stats,
  handle: FileHandle,
  info: Stats,
): Promise<void> {
  if (await realpath(selected).catch(() => null) !== canonical) {
    throw new Error("tap key selected path changed during verification");
  }
  const current = await handle.stat().catch(() => null);
  if (!current?.isFile() || !sameIdentity(identity(current), identity(info))) {
    throw new Error("tap key handle changed during verification");
  }
  await assertPathMatchesHandle(parentPath, parentInfo, "tap key parent");
  await assertPathMatchesHandle(canonical, info, "tap key file");
}

/** Decode a canonical Base64 key with no ignored or trailing bytes. */
export function decodeCanonicalBase64Key(text: string, label: string): Buffer {
  if (text.length === 0 || !CANONICAL_BASE64.test(text)) {
    throw new Error(`${label} must be canonical base64 with no ignored characters`);
  }
  const decoded = Buffer.from(text, "base64");
  if (decoded.toString("base64") !== text) {
    throw new Error(`${label} contains non-canonical base64 padding or trailing bytes`);
  }
  return decoded;
}

/** Decode exact key-file bytes and remove only one permitted trailing newline. */
export function decodeTapPublicKey(bytes: Buffer): string {
  return keyFileText(decodeUtf8(bytes, "tap key file"));
}

function keyFileText(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

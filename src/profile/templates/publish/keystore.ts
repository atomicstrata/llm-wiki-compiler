/**
 * @file src/profile/templates/publish/keystore.ts
 * @description Private-key storage for the publisher workspace.
 *
 * Private keys are created exclusively (`wx` — never overwriting an existing key),
 * stored `0600`, and read back with a bounded no-follow read so a planted symlink
 * cannot redirect a signing key. A `PrivateSigningKey` returned from here is passed
 * only to `signClaim`; it is never printed, logged, or written to the manifest.
 */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../../../utils/atomic-write.js";
import { readCappedNoFollowBuffer } from "../../../utils/confined-read.js";
import { isSlugSafe } from "../../identity.js";
import { generateEd25519Keypair, type PrivateSigningKey } from "../signing/sign.js";
import type { PublisherKey } from "../signing/types.js";
import type { WorkspacePaths } from "./workspace-paths.js";

const MAX_KEY_FILE_BYTES = 4_096;

/** Which signing identity a key belongs to. */
export type KeyRole = "tap" | "publisher";

/** Create one keypair, refusing to overwrite an existing private key. */
export async function createKeypairFile(
  paths: WorkspacePaths,
  keyId: string,
  role: KeyRole,
): Promise<PublisherKey> {
  assertSlugKeyId(keyId);
  const generated = generateEd25519Keypair(keyId);
  await writeExclusivePrivateKey(privateKeyPath(paths, role, keyId), generated.privateKey.privateKey, role, keyId);
  await atomicWrite(publicKeyPath(paths, role, keyId), `${generated.publicKey.publicKey}\n`, {
    confineRoot: paths.root,
    durable: true,
  });
  return generated.publicKey;
}

/** Read one private signing key with a bounded, no-follow read. */
export async function readPrivateKey(
  paths: WorkspacePaths,
  role: KeyRole,
  keyId: string,
): Promise<PrivateSigningKey> {
  assertSlugKeyId(keyId);
  const read = await readCappedNoFollowBuffer(privateKeyPath(paths, role, keyId), MAX_KEY_FILE_BYTES);
  if (read.kind !== "ok") throw new Error(`private key is missing, symlinked, or unreadable: ${role}/${keyId}`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(read.body).trim();
  } catch {
    throw new Error(`private key is not valid UTF-8: ${role}/${keyId}`);
  }
  if (text.length === 0) throw new Error(`private key is empty: ${role}/${keyId}`);
  return { keyId, privateKey: text };
}

/** SHA-256 fingerprint of a public key's SPKI bytes, for out-of-band comparison. */
export function publicKeyFingerprint(key: PublisherKey): string {
  return createHash("sha256").update(Buffer.from(key.publicKey, "base64")).digest("hex");
}

async function writeExclusivePrivateKey(
  file: string,
  privateKey: string,
  role: KeyRole,
  keyId: string,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, "wx", 0o600);
    await handle.writeFile(`${privateKey}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`private key already exists and is never overwritten: ${role}/${keyId}`);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function privateKeyPath(paths: WorkspacePaths, role: KeyRole, keyId: string): string {
  return path.join(paths.keysDir, `${role}-${keyId}.key`);
}

function publicKeyPath(paths: WorkspacePaths, role: KeyRole, keyId: string): string {
  return path.join(paths.keysDir, `${role}-${keyId}.pub`);
}

function assertSlugKeyId(keyId: string): void {
  if (!isSlugSafe(keyId)) throw new Error(`key id must be slug-safe: ${JSON.stringify(keyId)}`);
}

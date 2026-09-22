/**
 * @file src/capability-providers/runtime/broker-response-region.ts
 * @description Concrete host-written, guest-read-only broker-response region
 * (D6.1). It is provisioned in the invocation namespace before the sandbox is
 * sealed at launch. When a broker returns bytes too large to ride inline, the
 * host writes them here as a read-only payload file and hands the provider only
 * an opaque token that resolves to a sandbox-relative path — never a host path.
 * The bytes were already secret-scanned by the broker before they reached here.
 */
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, opendir, realpath, rm } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { parseSha256Digest } from "../ids.js";
import type { BrokerResponseRegionV1, PayloadDescriptorV1 } from "./invoke.js";

const REGION_DIRECTORY = "broker-responses";
const PAYLOAD_MEDIA_TYPE = "application/octet-stream";

/** A provisioned region plus the sandbox-relative mount and its disposer. */
export interface BrokerResponseRegionHandleV1 extends BrokerResponseRegionV1 {
  readonly sandboxMountRelative: string;
  dispose(): Promise<void>;
}

/** Provision the guest-read-only broker-response region before the sandbox seals. */
export async function createBrokerResponseRegion(
  invocationNamespaceDir: string,
): Promise<BrokerResponseRegionHandleV1> {
  const parent = await realpath(invocationNamespaceDir);
  const hostRoot = path.join(parent, REGION_DIRECTORY);
  await mkdir(hostRoot, { mode: 0o700 });
  const tokens = new Map<string, string>();
  return Object.freeze({
    sandboxMountRelative: REGION_DIRECTORY,
    materialize: (bytes: readonly Uint8Array[], provenanceLabel: string) =>
      materialize(hostRoot, tokens, bytes, provenanceLabel),
    dispose: () => disposeRegion(hostRoot),
  });
}

async function materialize(
  hostRoot: string, tokens: Map<string, string>,
  bytes: readonly Uint8Array[], provenanceLabel: string,
): Promise<PayloadDescriptorV1> {
  const token = `brp-${randomBytes(16).toString("hex")}`;
  const hash = createHash("sha256");
  let byteCount = 0;
  const leaf = path.join(hostRoot, token);
  const handle = await open(leaf, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o400);
  try {
    for (const chunk of bytes) {
      await handle.writeFile(chunk);
      hash.update(chunk);
      byteCount += chunk.byteLength;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  tokens.set(token, `${REGION_DIRECTORY}/${token}`);
  return Object.freeze({
    token, digest: parseSha256Digest(`sha256:${hash.digest("hex")}`), byteCount,
    mediaType: PAYLOAD_MEDIA_TYPE, provenanceLabel,
  });
}

/** Thaw and remove the region; cleanup failure stays visible, never silent. */
async function disposeRegion(hostRoot: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(hostRoot, 0o700).catch(() => {});
    const children = await opendir(hostRoot).catch(() => null);
    if (children) for await (const child of children) {
      await chmod(path.join(hostRoot, child.name), 0o600).catch(() => {});
    }
  }
  await rm(hostRoot, { recursive: true, force: true });
}

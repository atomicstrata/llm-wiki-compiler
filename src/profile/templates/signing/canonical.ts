/**
 * @file src/profile/templates/signing/canonical.ts
 * @description Single RFC 8785 canonical-byte and SHA-256 implementation for
 * every template signature and digest claim.
 */
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

/** Return canonical UTF-8 bytes or reject values RFC 8785 cannot represent. */
export function canonicalBytes(value: unknown): Buffer {
  const text = canonicalize(value);
  if (text === undefined) throw new Error("value cannot be canonically represented");
  return Buffer.from(text, "utf8");
}

/** Hash canonical JSON using the protocol's prefixed digest representation. */
export function canonicalDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalBytes(value)).digest("hex")}`;
}

/**
 * The exact bytes a tap-index signature covers: the complete index WITHOUT its
 * `signature` field. Producer and consumer MUST derive these bytes from this one
 * function — a second derivation is precisely how a signed index becomes
 * unverifiable, so `verifyTapIndex` consumes it too.
 */
export function tapIndexClaim(index: object & { signature?: unknown }): object {
  const { signature: _signature, ...claim } = index;
  return claim;
}

/** Publisher-signed package claim. */
export function packageClaim(coordinate: string, payloadDigest: string): object {
  return { coordinate, payloadDigest };
}

/** Publisher-key rotation claim signed by predecessor and successor. */
export function rotationClaim(tap: string, rotation: {
  publisher: string; fromKeyId: string; toKey: { keyId: string; publicKey: string }; effectiveSequence: number;
}): object {
  return {
    tap,
    publisher: rotation.publisher,
    fromKeyId: rotation.fromKeyId,
    toKey: rotation.toKey,
    effectiveSequence: rotation.effectiveSequence,
  };
}

/** Tap-root rotation claim signed by predecessor and successor. */
export function tapRotationClaim(tap: string, rotation: {
  fromKeyId: string; toKey: { keyId: string; publicKey: string }; effectiveSequence: number;
}): object {
  return { tap, fromKeyId: rotation.fromKeyId, toKey: rotation.toKey, effectiveSequence: rotation.effectiveSequence };
}

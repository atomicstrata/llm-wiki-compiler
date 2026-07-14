/**
 * @file src/profile/templates/signing/sign.ts
 * @description The ONLY place a private key is used. Produces production Ed25519
 * signatures over canonical claim bytes built by `canonical.ts`, so a publisher never
 * re-derives the bytes a verifier checks. Verification stays entirely in `verify.ts`.
 */
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { canonicalBytes } from "./canonical.js";
import type { Ed25519Signature, PublisherKey } from "./types.js";

/** A private signing key: PKCS8 DER, base64, bound to its public key id. */
export interface PrivateSigningKey {
  keyId: string;
  privateKey: string;
}

/** A freshly generated keypair in the protocol's wire formats. */
export interface GeneratedKeypair {
  publicKey: PublisherKey;
  privateKey: PrivateSigningKey;
}

/** Sign one canonical claim. The claim MUST come from `canonical.ts`. */
export function signClaim(claim: object, key: PrivateSigningKey): Ed25519Signature {
  const privateKey = importEd25519PrivateKey(key.privateKey);
  return {
    keyId: key.keyId,
    algorithm: "ed25519",
    value: sign(null, canonicalBytes(claim), privateKey).toString("base64"),
  };
}

/** Generate one Ed25519 keypair in the SPKI/PKCS8 base64 wire formats. */
export function generateEd25519Keypair(keyId: string): GeneratedKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: {
      keyId,
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    },
    privateKey: {
      keyId,
      privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    },
  };
}

/** Import a PKCS8 DER base64 private key, refusing anything that is not Ed25519. */
function importEd25519PrivateKey(privateKeyBase64: string): ReturnType<typeof createPrivateKey> {
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey({
      key: Buffer.from(privateKeyBase64, "base64"),
      format: "der",
      type: "pkcs8",
    });
  } catch {
    throw new Error("signing key is not a PKCS8 DER Ed25519 private key");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("signing key is not a PKCS8 DER Ed25519 private key");
  }
  return key;
}

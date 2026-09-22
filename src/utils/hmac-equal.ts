/** Constant-time comparison for canonical lowercase SHA-256 HMAC encodings. */
import { timingSafeEqual } from "node:crypto";

/** Validate encoding and fixed width before comparing authentication bytes. */
export function hmacHexEqual(stored: string, expected: string): boolean {
  const hex = /^[0-9a-f]{64}$/;
  if (!hex.test(stored) || !hex.test(expected)) return false;
  return timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(expected, "hex"));
}

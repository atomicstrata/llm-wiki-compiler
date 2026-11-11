/**
 * @file src/utils/verified-bytes-memo.ts
 * @description Remember the verdict of a pure verifier over exact bytes.
 *
 * Some stored records are immutable or append-only, and their verification —
 * strict decoding, a closed parse, recomputed digests, the canonical-bytes rule —
 * is a pure function of the bytes alone. A scan that re-reads every such record
 * on every pass re-ran that verification on bytes it had already proven, which
 * made a store of N records cost N verifications per pass.
 *
 * WHAT IS STILL DONE ON EVERY CALL: the caller still reads the bytes from disk,
 * through whatever confinement it already uses, and hands them here. Only the
 * verdict on bytes ALREADY verified is reused, and only for those exact bytes.
 *
 * WHY LATIN1. The key is the bytes as a latin1 string — one character per byte —
 * so two keys are equal exactly when the bytes are. A decoded-text key would not
 * do: a strict UTF-8 decoder drops a leading byte-order mark, so a BOM-prefixed
 * leaf and its canonical twin would share one verdict.
 *
 * Rejections are never remembered: a throw propagates and the next call
 * verifies again. Each caller gets its own structured copy, so no caller can edit
 * the value another caller (or the memo) holds. Memory is bounded by the total
 * key bytes held, oldest first out.
 */

/** Total key bytes one memo keeps before evicting its oldest entries. */
const DEFAULT_MEMO_BYTES = 16 * 1024 * 1024;

/**
 * Wrap `verify` so a repeat of the exact same bytes returns a copy of the first
 * verdict instead of verifying again. `verify` must be a pure function of its bytes.
 */
export function verifiedBytesMemo<T>(verify: (bytes: Buffer) => T, maxBytes = DEFAULT_MEMO_BYTES): (bytes: Buffer) => T {
  const verdicts = new Map<string, T>();
  let heldBytes = 0;
  return (bytes) => {
    const key = bytes.toString("latin1");
    const known = verdicts.get(key);
    if (known !== undefined) return structuredClone(known);
    const value = verify(bytes);
    if (key.length > maxBytes) return value;
    while (heldBytes + key.length > maxBytes) {
      const oldest = verdicts.keys().next().value as string;
      verdicts.delete(oldest);
      heldBytes -= oldest.length;
    }
    verdicts.set(key, structuredClone(value));
    heldBytes += key.length;
    return value;
  };
}

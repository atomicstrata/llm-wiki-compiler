/** Remember the verdict of a pure verifier over exact bytes (or exact text). */

const MAX_MEMO_KEY_LENGTH = 16 * 1024 * 1024;

/** Wrap `verify` so a repeat of the exact same bytes returns a copy of the first verdict instead of verifying again. */
export function verifiedBytesMemo<T>(verify: (bytes: Buffer) => T): (bytes: Buffer) => T {
  return verdictMemo((bytes: Buffer) => bytes.toString("latin1"), verify);
}

/** {@link verifiedBytesMemo} for a verifier whose input is text the caller already decoded: the text itself is the key, so two keys are equal exactly when the texts are. */
export function verifiedTextMemo<T>(verify: (text: string) => T): (text: string) => T {
  return verdictMemo((text: string) => text, verify);
}

function verdictMemo<I, T>(keyOf: (input: I) => string, verify: (input: I) => T): (input: I) => T {
  const verdicts = new Map<string, T>();
  let heldKeyLength = 0;
  return (input) => {
    const key = keyOf(input);
    const known = verdicts.get(key);
    if (known !== undefined) return structuredClone(known);
    const value = verify(input);
    if (key.length > MAX_MEMO_KEY_LENGTH) return value;
    while (heldKeyLength + key.length > MAX_MEMO_KEY_LENGTH) {
      const oldest = verdicts.keys().next().value as string;
      verdicts.delete(oldest);
      heldKeyLength -= oldest.length;
    }
    verdicts.set(key, structuredClone(value));
    heldKeyLength += key.length;
    return value;
  };
}

/**
 * @file test/storage/flipped-integrity.ts
 * @description One alteration shared by the storage tests that hold a REAL
 * STAGED RUN'S TEXT in memory and need the same text with its HMAC tag made
 * wrong: `preparation-key-read-binding.test.ts` and
 * `preparation-record-reads-binding.test.ts`. Each of them shows that a run
 * whose `integrity` differs by one hex digit still parses, and then fails the
 * comparison against the key. How that one digit is changed, and the check
 * that only the tag was changed, were written out identically in both files.
 * They are stated once, here.
 *
 * WHAT IT DOES. It takes the run's text and the `integrity` value that text
 * carries, asserts that the value occurs in the text EXACTLY ONCE, and returns
 * the text with the value's last hex digit changed: `0` becomes `1`, anything
 * else becomes `0`. Nothing else in the text is touched, so every other field
 * parses as before.
 *
 * WHAT IT IS NOT. It does not parse the run and does not find the tag: the
 * calling test supplies `integrity`, from the real parser or from the run it
 * already parsed, and keeps that choice. It reads and writes no file. It is not
 * the on-disk corruption other tests perform by re-serializing a record. It is
 * not a general test framework: it holds this one function and nothing else.
 */

import { expect } from "bun:test";

/**
 * `runText` with the last hex digit of its `integrity` value flipped.
 *
 * @param runText - A staged run leaf's text, as the real writer wrote it.
 * @param integrity - The `integrity` value that text carries.
 * @returns The same text with only that value's last digit changed.
 */
export function runTextWithLastIntegrityDigitFlipped(runText: string, integrity: string): string {
  const flipped = `${integrity.slice(0, -1)}${integrity.endsWith("0") ? "1" : "0"}`;
  expect(runText.split(integrity)).toHaveLength(2);
  return runText.replace(integrity, flipped);
}

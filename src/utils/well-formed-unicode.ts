/**
 * @file src/utils/well-formed-unicode.ts
 * @description Shared bounded UTF-16 well-formedness predicate for physical
 * identity trust boundaries. Callers apply their O(1) code-unit cap first, so
 * this scan never turns a hostile unbounded value into unbounded work.
 */

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

/** True when `value` contains only paired UTF-16 surrogate code units. */
export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= LOW_SURROGATE_MIN && codeUnit <= LOW_SURROGATE_MAX) return false;
    if (codeUnit < HIGH_SURROGATE_MIN || codeUnit > HIGH_SURROGATE_MAX) continue;
    if (index + 1 >= value.length) return false;
    const next = value.charCodeAt(index + 1);
    if (next < LOW_SURROGATE_MIN || next > LOW_SURROGATE_MAX) return false;
    index += 1;
  }
  return true;
}

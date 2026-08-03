/**
 * @file test/fixtures/strip-comments.ts
 * @description Shared comment-blanking helper for the executable grep gates.
 *
 * Gates that assert "this source never mentions X" must ignore prose, or a
 * docstring explaining WHY X is forbidden would trip the gate it documents.
 * Comment bytes are blanked rather than deleted so reported line numbers stay
 * accurate, and string literals are kept verbatim so a name smuggled through a
 * string still trips the gate.
 *
 * Used by `test/genericity-grep-gate.test.ts` and
 * `test/profile-posix-path-gate.test.ts`.
 */

/** Match strings/comments; used to blank comment bytes while preserving strings + newlines. */
const STRINGS_OR_COMMENTS = /("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')|(`(?:\\.|[^`\\])*`)|(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)/g;

/** Blank comment content (keep string literals verbatim, preserve newlines for line numbers). */
export function stripComments(src: string): string {
  return src.replace(STRINGS_OR_COMMENTS, (m, dq, sq, tpl) =>
    dq || sq || tpl ? m : m.replace(/[^\n]/g, " "));
}

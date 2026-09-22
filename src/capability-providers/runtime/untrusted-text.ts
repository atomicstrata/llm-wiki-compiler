/**
 * @file src/capability-providers/runtime/untrusted-text.ts
 * @description ONE home for every provider-controlled string the host echoes into a
 * host-authored line — a claim's output id, a provider's own failure reason. The host
 * renders these lines as its own text (`preparation show`, the durable leg detail), so
 * a provider must not be able to break the line, escape the terminal, reorder the
 * text, or forge a host-looking follow-on line through any of them. Every echo is
 * collapsed to one printable line, bounded in UTF-8 bytes, and — for a bare token —
 * visibly quoted so the reader can see where the provider's bytes start and stop.
 */

/** Every code point that can break, escape, or reorder a host-rendered line: all controls (C0 and C1), format characters (bidi overrides, zero-widths), and line/paragraph separators. */
const HOST_LINE_UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/** The most bytes a bare provider token (an output id) may occupy in a host line. */
const MAX_PROVIDER_TOKEN_BYTES = 128;

/** Cut `text` to at most `maxBytes` of UTF-8 without leaving a torn code point behind. */
function boundedUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
}

/** Provider text as ONE printable line: unsafe code points become spaces, runs collapse, and the result is byte-bounded. */
export function neutralisedProviderText(text: string, maxBytes: number): string {
  return boundedUtf8(text.replace(HOST_LINE_UNSAFE, " ").replace(/\s{2,}/g, " ").trim(), maxBytes);
}

/** The delimiters a quoted token may not contain, or it could visually close and reopen its own region. */
const DELIMITERS = /[«»]/g;

/**
 * A bare provider token quoted for a host line: `«…»` marks EXACTLY where the untrusted
 * bytes start and stop, so any guillemet inside the token is replaced first — a token
 * such as `x» HOST: accepted «y` would otherwise forge a closed-then-reopened region
 * while staying on one line.
 */
export function quotedProviderToken(token: string): string {
  return `«${neutralisedProviderText(token, MAX_PROVIDER_TOKEN_BYTES).replace(DELIMITERS, "\"")}»`;
}

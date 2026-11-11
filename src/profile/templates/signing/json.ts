/**
 * @file src/profile/templates/signing/json.ts
 * @description Bounded JSON parsing that rejects duplicate object keys before
 * native JSON parsing can silently collapse them.
 *
 * The shape scan walks every signed record a store reads, so it works on UTF-16
 * code units rather than one-character strings: whitespace is tested by code
 * with the `\s` regex kept only for the rare non-ASCII candidate, a string with
 * no escape is sliced rather than re-parsed, the next quote, escape, or control
 * character inside a string is found by one native regex search rather than a
 * loop, and a number is matched in place with a sticky regex rather than against
 * a copy of the rest of the text. Each
 * shortcut accepts and rejects exactly what the per-character form did, at the
 * same byte offset.
 */

/** The JSON number grammar, matched at an explicit offset (`lastIndex`). */
const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
/** The next code unit a string scan must stop at: its closing quote, an escape, or a control character. */
const STRING_STOP = /["\\\u0000-\u001f]/g;
/** The JavaScript `\s` class, consulted only for code units at or above U+00A0. */
const NON_ASCII_SPACE = /\s/;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const FIRST_NON_ASCII_SPACE = 0xa0;

/** Parse bounded JSON after validating depth, syntax, and key uniqueness. */
export function parseBoundedUniqueJson(text: string, maxBytes: number, maxDepth = 32): unknown {
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("signed JSON exceeds its byte cap");
  new JsonShapeScanner(text, maxDepth).scan();
  return JSON.parse(text);
}

class JsonShapeScanner {
  private position = 0;

  constructor(private readonly text: string, private readonly maxDepth: number) {}

  scan(): void {
    this.scanValue(0);
    this.skipSpace();
    if (this.position !== this.text.length) this.fail("trailing content");
  }

  private scanValue(depth: number): void {
    if (depth > this.maxDepth) this.fail("JSON nesting exceeds its depth cap");
    this.skipSpace();
    const char = this.text[this.position];
    if (this.scanStructured(char, depth)) return;
    this.scanScalar(char);
  }

  private scanStructured(char: string | undefined, depth: number): boolean {
    if (char === "{") this.scanObject(depth + 1);
    else if (char === "[") this.scanArray(depth + 1);
    else return false;
    return true;
  }

  private scanScalar(char: string | undefined): void {
    if (char === '"') return void this.scanString();
    if (char === "-" || isDigit(char)) return this.scanNumber();
    if (char === "t") return this.scanLiteral("true");
    if (char === "f") return this.scanLiteral("false");
    if (char === "n") return this.scanLiteral("null");
    this.fail("invalid JSON value");
  }

  private scanObject(depth: number): void {
    this.position++;
    const keys = new Set<string>();
    if (this.consumeClosing("}")) return;
    while (true) {
      this.skipSpace();
      const key = this.scanString();
      if (keys.has(key)) this.fail(`duplicate JSON key: ${key}`);
      keys.add(key);
      this.expect(":");
      this.scanValue(depth);
      if (this.consumeClosing("}")) return;
      this.expect(",");
    }
  }

  private scanArray(depth: number): void {
    this.position++;
    if (this.consumeClosing("]")) return;
    while (true) {
      this.scanValue(depth);
      if (this.consumeClosing("]")) return;
      this.expect(",");
    }
  }

  private scanString(): string {
    this.skipSpace();
    const start = this.position;
    if (this.text[this.position++] !== '"') this.fail("expected JSON string");
    let escaped = false;
    while (true) {
      STRING_STOP.lastIndex = this.position;
      if (!STRING_STOP.test(this.text)) break;
      this.position = STRING_STOP.lastIndex;
      const code = this.text.charCodeAt(this.position - 1);
      if (code === QUOTE) return this.stringValue(start, escaped);
      if (code !== BACKSLASH) this.fail("control character in JSON string");
      escaped = true;
      this.scanEscape();
    }
    this.position = this.text.length;
    this.fail("unterminated JSON string");
  }

  /** An escape-free string is exactly its source code units; only escapes need decoding. */
  private stringValue(start: number, escaped: boolean): string {
    const literal = this.text.slice(start, this.position);
    return escaped ? JSON.parse(literal) as string : literal.slice(1, -1);
  }

  private scanEscape(): void {
    const escaped = this.text[this.position++];
    if ('"\\/bfnrt'.includes(escaped)) return;
    if (escaped !== "u") this.fail("invalid JSON escape");
    const hex = this.text.slice(this.position, this.position + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("invalid Unicode escape");
    this.position += 4;
  }

  private scanNumber(): void {
    JSON_NUMBER.lastIndex = this.position;
    if (!JSON_NUMBER.test(this.text)) this.fail("invalid JSON number");
    this.position = JSON_NUMBER.lastIndex;
  }

  private scanLiteral(literal: string): void {
    if (!this.text.startsWith(literal, this.position)) this.fail("invalid JSON literal");
    this.position += literal.length;
  }

  private consumeClosing(char: string): boolean {
    this.skipSpace();
    if (this.text[this.position] !== char) return false;
    this.position++;
    return true;
  }

  private expect(char: string): void {
    this.skipSpace();
    if (this.text[this.position++] !== char) this.fail(`expected ${char}`);
  }

  private skipSpace(): void {
    while (this.position < this.text.length && isSpace(this.text.charCodeAt(this.position))) this.position++;
  }

  private fail(message: string): never {
    throw new Error(`${message} at byte ${this.position}`);
  }
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

/** Whether one UTF-16 code unit is in the JavaScript `\s` class. */
function isSpace(code: number): boolean {
  if (code < FIRST_NON_ASCII_SPACE) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  return NON_ASCII_SPACE.test(String.fromCharCode(code));
}

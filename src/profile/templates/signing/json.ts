/**
 * @file src/profile/templates/signing/json.ts
 * @description Bounded JSON parsing that rejects duplicate object keys before
 * native JSON parsing can silently collapse them.
 */

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
    while (this.position < this.text.length) {
      const char = this.text[this.position++];
      if (char === '"') return JSON.parse(this.text.slice(start, this.position)) as string;
      if (char === "\\") this.scanEscape();
      else if (char.charCodeAt(0) < 0x20) this.fail("control character in JSON string");
    }
    this.fail("unterminated JSON string");
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
    const rest = this.text.slice(this.position);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (!match) this.fail("invalid JSON number");
    this.position += match[0].length;
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
    while (/\s/.test(this.text[this.position] ?? "")) this.position++;
  }

  private fail(message: string): never {
    throw new Error(`${message} at byte ${this.position}`);
  }
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

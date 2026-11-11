/**
 * @file src/utils/yaml-dump.ts
 * @description The one YAML writer: js-yaml's `dump`, loaded on first use.
 *
 * Every written page's frontmatter, and `llmwiki schema init`'s schema file,
 * carry js-yaml's exact output bytes: quoted ISO dates and YAML 1.1 words,
 * `|-` blocks for multi-line text, no line folding. `Bun.YAML.stringify`
 * writes different bytes for the same values (unquoted dates, escaped
 * newlines) and its output varies across Bun releases, so it is not used.
 *
 * Reading never needs js-yaml (frontmatter is parsed with `Bun.YAML.parse`),
 * so it is required here, on the first write, rather than imported by every
 * command.
 */

import type jsYaml from "js-yaml";
import { requireOnUse } from "./require-on-use.js";

/** No line folding; double quotes where a value must be quoted. */
const DUMP_OPTIONS: jsYaml.DumpOptions = { lineWidth: -1, quotingType: '"' };

/**
 * `value` as YAML, in the bytes every written page already carries.
 *
 * @param value - Plain data: objects, arrays, strings, numbers, booleans, null.
 * @returns The YAML text, ending in a newline.
 */
export function dumpYaml(value: unknown): string {
  return requireOnUse<typeof jsYaml>("js-yaml").dump(value, DUMP_OPTIONS);
}

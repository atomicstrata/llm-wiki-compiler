/**
 * @file Shared MCP CallToolResult builders.
 *
 * Every tool handler returns the same envelope shape, so the construction of
 * success/error results lives here as the single source of truth — `tools.ts`
 * and `okf-tools.ts` both import these rather than each keeping a local copy.
 */

/**
 * Wrap an arbitrary JSON value as the standard MCP CallToolResult.
 * MCP requires content blocks even for structured payloads, so we mirror
 * the JSON in a text block for clients that don't read structuredContent.
 *
 * The return type is an inline object literal (not a named interface) so it
 * stays structurally assignable to the SDK's `CallToolResult`, whose own type
 * carries an index signature that a named interface would not satisfy.
 */
export function jsonResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { result: unknown };
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: { result: payload },
  };
}

/** Wrap an error message as an MCP error result (flagged with `isError`). */
export function errorResult(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/**
 * Adapter for Claude Code session exports.
 *
 * Claude Code writes session transcripts as newline-delimited JSON (`.jsonl`)
 * under `~/.claude/projects/<project>/<session>.jsonl`. Each line is a JSON
 * object representing one event in the session.
 *
 * Supported event schemas (as observed in Claude Code v≥0.2):
 *   - `{ type: "user", message: { role: "user", content: <string|array> } }`
 *   - `{ type: "assistant", message: { role: "assistant", content: <string|array> } }`
 *
 * The adapter extracts the first user message as the session title and records
 * the timestamp range from `timestamp` fields when present.
 */

import path from "path";
import type { SessionAdapter, NormalizedSession, SessionTurn } from "./types.js";
import { resolveSessionTitle } from "./utils.js";

const CLAUDE_EXTENSION = ".jsonl";

/** Known marker strings in the first line that confirm Claude Code origin. */
const CLAUDE_TYPE_MARKERS = new Set(["user", "assistant", "system", "tool_use", "tool_result"]);

interface ClaudeContentBlock {
  type: string;
  text?: string;
}

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
}

interface ClaudeEvent {
  type: string;
  message?: ClaudeMessage;
  timestamp?: string;
}

/** Extract plain text from a Claude content value (string or block array). */
function extractText(content: string | ClaudeContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** Derive a title from the first non-empty user turn text. */
function titleFromFirstUserMessage(turns: SessionTurn[]): string {
  const firstUser = turns.find((t) => t.role === "user" && t.content.trim().length > 0);
  return resolveSessionTitle(undefined, firstUser?.content, "Claude Session");
}

/** Parse a single JSONL line into a ClaudeEvent, returning null on failure. */
function parseLine(line: string): ClaudeEvent | null {
  try {
    return JSON.parse(line) as ClaudeEvent;
  } catch {
    return null;
  }
}

/** Convert a ClaudeEvent into a SessionTurn, or null if not a conversation event. */
function eventToTurn(event: ClaudeEvent): SessionTurn | null {
  if (!event.message || !event.message.role) return null;
  const role = event.message.role;
  if (role !== "user" && role !== "assistant") return null;

  const content = extractText(event.message.content);
  if (content.trim().length === 0) return null;

  return { role, content, timestamp: event.timestamp };
}

export const claudeAdapter: SessionAdapter = {
  name: "claude",

  async detect(filePath: string): Promise<boolean> {
    if (path.extname(filePath).toLowerCase() !== CLAUDE_EXTENSION) return false;
    const raw = await Bun.file(filePath).text().catch(() => "");
    const firstLine = raw.split("\n")[0].trim();
    if (!firstLine.startsWith("{")) return false;
    try {
      const obj = JSON.parse(firstLine) as ClaudeEvent;
      return typeof obj.type === "string" && CLAUDE_TYPE_MARKERS.has(obj.type);
    } catch {
      return false;
    }
  },

  async parse(filePath: string): Promise<NormalizedSession> {
    const raw = await Bun.file(filePath).text();
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

    if (lines.length === 0) {
      throw new Error(`Claude session file is empty: ${filePath}`);
    }

    const turns: SessionTurn[] = [];
    const timestamps: string[] = [];

    for (const [index, line] of lines.entries()) {
      const event = parseLine(line);
      if (event === null) {
        throw new Error(
          `Malformed JSON on line ${index + 1} of Claude session: ${filePath}`
        );
      }
      if (event.timestamp) timestamps.push(event.timestamp);
      const turn = eventToTurn(event);
      if (turn) turns.push(turn);
    }

    const title = titleFromFirstUserMessage(turns);

    return {
      title,
      adapter: "claude",
      startedAt: timestamps[0],
      endedAt: timestamps[timestamps.length - 1],
      participantIdentity: "Claude Code",
      turns,
    };
  },
};

/**
 * Adapter for Cursor conversation history exports.
 *
 * Cursor AI can export conversation history as JSON files. The schema
 * reflects Cursor's internal chat format:
 * ```json
 * { "tabs": [{ "title": "...",
 *              "messages": [{ "role": "user"|"assistant",
 *                             "content": "...",
 *                             "timestamp": "..." }] }] }
 * ```
 *
 * When the export contains multiple tabs, only the first tab is parsed.
 * A top-level `messages` array (without `tabs`) is also supported for
 * simpler single-conversation exports.
 */

import path from "path";
import type { SessionAdapter, NormalizedSession, SessionTurn } from "./types.js";
import { resolveSessionTitle, readSessionJson } from "./utils.js";

const CURSOR_EXTENSION = ".json";

interface CursorMessage {
  role: string;
  content: string;
  timestamp?: string;
}

interface CursorTab {
  title?: string;
  messages: CursorMessage[];
}

interface CursorTabsExport {
  tabs: CursorTab[];
}

interface CursorFlatExport {
  messages: CursorMessage[];
  title?: string;
}

type CursorExport = CursorTabsExport | CursorFlatExport;

/** Guard: does the value look like a Cursor tabs export? */
function isTabsExport(value: unknown): value is CursorTabsExport {
  return (
    typeof value === "object" &&
    value !== null &&
    "tabs" in value &&
    Array.isArray((value as CursorTabsExport).tabs)
  );
}

/** Guard: does the value look like a Cursor flat messages export? */
function isFlatExport(value: unknown): value is CursorFlatExport {
  return (
    typeof value === "object" &&
    value !== null &&
    "messages" in value &&
    Array.isArray((value as CursorFlatExport).messages)
  );
}

/** Extract the raw messages and optional title from a Cursor export. */
function extractMessagesAndTitle(
  data: CursorExport
): { messages: CursorMessage[]; title?: string } {
  if (isTabsExport(data)) {
    const tab = data.tabs[0];
    return { messages: tab?.messages ?? [], title: tab?.title };
  }
  return { messages: data.messages, title: data.title };
}

/** Convert raw Cursor messages to normalised SessionTurns. */
function toTurns(messages: CursorMessage[]): SessionTurn[] {
  const turns: SessionTurn[] = [];
  for (const msg of messages) {
    const role = msg.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = (msg.content ?? "").trim();
    if (content.length === 0) continue;
    turns.push({ role, content, timestamp: msg.timestamp });
  }
  return turns;
}

export const cursorAdapter: SessionAdapter = {
  name: "cursor",

  async detect(filePath: string): Promise<boolean> {
    if (path.extname(filePath).toLowerCase() !== CURSOR_EXTENSION) return false;
    const raw = await Bun.file(filePath).text().catch(() => "");
    if (raw.trimStart()[0] !== "{") return false;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isTabsExport(parsed) || isFlatExport(parsed);
    } catch {
      return false;
    }
  },

  async parse(filePath: string): Promise<NormalizedSession> {
    const parsed = await readSessionJson(filePath);

    if (!isTabsExport(parsed) && !isFlatExport(parsed)) {
      throw new Error(
        `Cursor session file does not match a known Cursor export schema: ${filePath}`
      );
    }

    const { messages, title: rawTitle } = extractMessagesAndTitle(parsed as CursorExport);
    const turns = toTurns(messages);
    const firstUser = turns.find((t) => t.role === "user");

    const timestamps = turns
      .filter((t) => t.timestamp != null)
      .map((t) => t.timestamp as string);

    return {
      title: resolveSessionTitle(rawTitle, firstUser?.content, "Cursor Session"),
      adapter: "cursor",
      startedAt: timestamps[0],
      endedAt: timestamps[timestamps.length - 1],
      participantIdentity: "Cursor AI",
      turns,
    };
  },
};

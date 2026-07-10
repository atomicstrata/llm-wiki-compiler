/**
 * @file src/utils/claude-settings-reader.ts
 * @description The settings-FILE-READER half of the Claude settings fallback: locate
 * `~/.claude/settings.json` (or the `LLMWIKI_CLAUDE_SETTINGS_PATH` override), read and
 * parse it, and extract ONLY the Anthropic-related `env` values llmwiki can safely
 * consume. Split out of `./claude-settings.ts` — which keeps the config-RESOLVER half
 * (apiKey / authToken / baseURL precedence) and re-exports {@link readClaudeSettingsEnv}
 * so its public API is unchanged — so each module carries one responsibility. Read-only;
 * never mutates process env.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CLAUDE_SETTINGS_PATH_ENV = "LLMWIKI_CLAUDE_SETTINGS_PATH";

interface ClaudeSettingsEnv {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_MODEL?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Trim a value to a non-empty string, or `undefined` when it is not a usable string. */
export function normalize(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveClaudeSettingsPath(env: NodeJS.ProcessEnv): string {
  return env[CLAUDE_SETTINGS_PATH_ENV] ?? path.join(homedir(), ".claude", "settings.json");
}

function readClaudeSettingsFile(settingsPath: string): string | undefined {
  try {
    return readFileSync(settingsPath, "utf8");
  } catch (err) {
    if (isRecord(err) && err.code === "ENOENT") {
      return undefined;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read Claude settings at "${settingsPath}": ${message}`);
  }
}

/**
 * Read the Anthropic-related `env` values from the settings file, or `undefined`
 * when the file is absent, has no usable `env` object, or names none of the four
 * consumable keys. Throws only on a genuine read/parse fault.
 */
export function readClaudeSettingsEnv(env: NodeJS.ProcessEnv = process.env): ClaudeSettingsEnv | undefined {
  const settingsPath = resolveClaudeSettingsPath(env);
  const raw = readClaudeSettingsFile(settingsPath);
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse Claude settings at "${settingsPath}": ${message}`);
  }

  if (!isRecord(parsed) || !isRecord(parsed.env)) {
    return undefined;
  }

  const values: ClaudeSettingsEnv = {
    ANTHROPIC_API_KEY: normalize(parsed.env.ANTHROPIC_API_KEY),
    ANTHROPIC_AUTH_TOKEN: normalize(parsed.env.ANTHROPIC_AUTH_TOKEN),
    ANTHROPIC_BASE_URL: normalize(parsed.env.ANTHROPIC_BASE_URL),
    ANTHROPIC_MODEL: normalize(parsed.env.ANTHROPIC_MODEL),
  };

  if (!values.ANTHROPIC_API_KEY && !values.ANTHROPIC_AUTH_TOKEN && !values.ANTHROPIC_BASE_URL && !values.ANTHROPIC_MODEL) {
    return undefined;
  }
  return values;
}

/** {@link readClaudeSettingsEnv} that swallows any read/parse fault into `undefined`. */
export function tryReadClaudeSettingsEnv(env: NodeJS.ProcessEnv): ClaudeSettingsEnv | undefined {
  try {
    return readClaudeSettingsEnv(env);
  } catch {
    return undefined;
  }
}

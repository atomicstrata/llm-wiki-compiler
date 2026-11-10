import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  readClaudeSettingsEnv,
  resolveAnthropicAuthFromEnv,
  resolveAnthropicBaseURLFromEnv,
  resolveAnthropicModelFromEnv,
} from "../src/utils/claude-settings.js";

const TEST_SETTINGS_PATH_ENV = "LLMWIKI_CLAUDE_SETTINGS_PATH";
const tempDirs: string[] = [];

function createSettingsEnv(content: string): NodeJS.ProcessEnv {
  const dir = mkdtempSync(path.join(tmpdir(), "llmwiki-claude-settings-"));
  tempDirs.push(dir);
  const settingsPath = path.join(dir, "settings.json");
  writeFileSync(settingsPath, content, "utf8");
  return { [TEST_SETTINGS_PATH_ENV]: settingsPath };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Claude settings fallback", () => {
  it("returns undefined when settings file is missing", () => {
    const missingPath = path.join(tmpdir(), `llmwiki-missing-${Date.now()}`, "settings.json");
    const result = readClaudeSettingsEnv({ [TEST_SETTINGS_PATH_ENV]: missingPath });
    expect(result).toBeUndefined();
  });

  it("extracts only supported Anthropic env keys", () => {
    const env = createSettingsEnv(
      JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: " token-123 ",
          ANTHROPIC_BASE_URL: " https://api.kimi.com/coding/ ",
          ANTHROPIC_MODEL: "Kimi-2.5",
          SOME_OTHER_KEY: "ignored",
        },
      }),
    );

    expect(readClaudeSettingsEnv(env)).toEqual({
      ANTHROPIC_AUTH_TOKEN: "token-123",
      ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
      ANTHROPIC_MODEL: "Kimi-2.5",
    });
  });

  it("throws a clear error when settings JSON is malformed", () => {
    const env = createSettingsEnv("{ not-valid-json }");
    expect(() => readClaudeSettingsEnv(env)).toThrow("Failed to parse Claude settings");
  });

  it("resolves auth from fallback when explicit auth is missing", () => {
    const env = {
      ...createSettingsEnv(JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "fallback-token" } })),
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
    };

    expect(resolveAnthropicAuthFromEnv(env)).toEqual({ authToken: "fallback-token" });
  });

  it("prefers explicit ANTHROPIC_API_KEY over fallback auth token", () => {
    const env = {
      ...createSettingsEnv(JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "fallback-token" } })),
      ANTHROPIC_API_KEY: "explicit-key",
    };

    expect(resolveAnthropicAuthFromEnv(env)).toEqual({ apiKey: "explicit-key" });
  });

  it("resolves base URL from fallback and allows path endpoints", () => {
    const env = createSettingsEnv(JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/" } }));
    expect(resolveAnthropicBaseURLFromEnv(env)).toBe("https://api.kimi.com/coding/");
  });

  it("resolves anthropic model from fallback when LLMWIKI_MODEL is absent", () => {
    const env = createSettingsEnv(JSON.stringify({ env: { ANTHROPIC_MODEL: "Kimi-2.5" } }));
    expect(resolveAnthropicModelFromEnv(env)).toBe("Kimi-2.5");
  });

  it("keeps explicit LLMWIKI_MODEL over fallback model", () => {
    const env = {
      ...createSettingsEnv(JSON.stringify({ env: { ANTHROPIC_MODEL: "Kimi-2.5" } })),
      LLMWIKI_MODEL: "claude-3-5-sonnet-latest",
    };
    expect(resolveAnthropicModelFromEnv(env)).toBe("claude-3-5-sonnet-latest");
  });
});

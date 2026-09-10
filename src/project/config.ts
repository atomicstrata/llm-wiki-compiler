/**
 * Shared project configuration reader. Missing configuration uses caller
 * defaults; consumers validate their own versioned settings after JSON loading.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LLMWIKI_DIR } from "../utils/constants.js";

/** A present configuration cannot be interpreted safely. */
export class ProjectConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectConfigError";
  }
}

/** Require an object, retaining unknown keys for other config consumers. */
export function requireConfigRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectConfigError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Validate the versioned envelope for settings that require version 1. */
export function normalizeProjectConfig(raw: unknown): Record<string, unknown> {
  const config = requireConfigRecord(raw, "config");
  if (config.version !== 1) throw new ProjectConfigError('.llmwiki/config.json requires "version": 1');
  return config;
}

/** Read the shared config; only an absent file permits default behavior. */
export async function loadProjectConfig(root: string): Promise<Record<string, unknown> | null> {
  let body: string;
  try {
    body = await readFile(path.join(root, LLMWIKI_DIR, "config.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ProjectConfigError(`Invalid .llmwiki/config.json: ${String(error)}`);
  }
  try {
    return requireConfigRecord(JSON.parse(body), "config");
  } catch (error) {
    if (error instanceof ProjectConfigError) throw error;
    throw new ProjectConfigError(`Invalid .llmwiki/config.json: ${String(error)}`);
  }
}

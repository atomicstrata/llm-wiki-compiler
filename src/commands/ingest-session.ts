/**
 * Commander action for `llmwiki ingest-session <path>`.
 *
 * Accepts a single session export file or a directory of session files.
 * Each file is detected, parsed, and written to `sources/` as a markdown
 * document with YAML frontmatter recording the adapter name and timestamps.
 *
 * Supported formats (auto-detected): Claude, Codex, Cursor.
 */

import path from "path";
import { readdir, stat } from "fs/promises";
import { buildFrontmatter } from "../utils/markdown.js";
import { saveSource } from "../utils/source-writer.js";
import * as output from "../utils/output.js";
import { parseSessionFile, formatSessionAsMarkdown } from "../adapters/registry.js";
import type { NormalizedSession } from "../adapters/types.js";

/** Result of ingesting a single session file. */
interface SessionIngestResult {
  filename: string;
  adapter: string;
  title: string;
  source: string;
}

/** Build the YAML frontmatter for a session source. */
function buildSessionFrontmatter(session: NormalizedSession, sourcePath: string): string {
  const meta: Record<string, unknown> = {
    title: session.title,
    source: sourcePath,
    adapter: session.adapter,
    ingestedAt: new Date().toISOString(),
  };
  if (session.startedAt) meta.sessionStartedAt = session.startedAt;
  if (session.endedAt) meta.sessionEndedAt = session.endedAt;
  if (session.participantIdentity) meta.participant = session.participantIdentity;

  return buildFrontmatter(meta);
}

/**
 * Write a session as a markdown file under `sources/` using the shared
 * source writer — gets the empty-slug guard (#35) and the
 * basename-collision suffix (#36) for free, so two sessions with the
 * same title from different transcript files coexist instead of one
 * silently overwriting the other.
 */
async function saveSessionSource(
  root: string,
  session: NormalizedSession,
  sourcePath: string,
): Promise<string> {
  const frontmatter = buildSessionFrontmatter(session, sourcePath);
  const body = formatSessionAsMarkdown(session);
  const document = `${frontmatter}\n\n${body}\n`;
  return saveSource(root, session.title, document, sourcePath);
}

/**
 * Ingest a single session file.
 * @param root - Absolute path to the wiki root directory.
 * @throws When the file is not recognised or is malformed.
 */
export async function ingestSessionFile(root: string, filePath: string): Promise<SessionIngestResult> {
  output.status("*", output.info(`Ingesting session: ${filePath}`));

  const session = await parseSessionFile(filePath);
  const savedPath = await saveSessionSource(root, session, filePath);

  output.status(
    "+",
    output.success(
      `Saved ${output.bold(path.basename(savedPath))} [${session.adapter}] → ${output.source(savedPath)}`
    )
  );

  return {
    filename: path.basename(savedPath),
    adapter: session.adapter,
    title: session.title,
    source: filePath,
  };
}

/** Collect all files directly inside a directory (non-recursive). */
async function listDirectoryFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath);
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dirPath, entry);
    const info = await stat(full);
    if (info.isFile()) files.push(full);
  }

  return files;
}

/**
 * Ingest all session files in a directory. Recognised files import; the
 * rest are skipped with a warning so a single bad file doesn't abort
 * the whole batch.
 *
 * Throws when ZERO files imported successfully, even if the directory
 * contained candidate files. A bulk run with nothing usable is a
 * failure mode the user needs to know about — exiting 0 with "Imported
 * 0 session(s), skipped N" was easy to miss in scripts.
 */
async function ingestDirectory(root: string, dirPath: string): Promise<void> {
  const files = await listDirectoryFiles(dirPath);

  if (files.length === 0) {
    throw new Error(`No files found in directory: ${dirPath}`);
  }

  output.status("*", output.info(`Scanning ${files.length} file(s) in: ${dirPath}`));

  let imported = 0;
  let skipped = 0;

  for (const file of files) {
    try {
      await ingestSessionFile(root, file);
      imported++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.status("!", output.warn(`Skipped ${path.basename(file)}: ${message}`));
      skipped++;
    }
  }

  if (imported === 0) {
    throw new Error(
      `No sessions imported from ${dirPath} (${skipped} file(s) skipped). ` +
        `Check that at least one file is in a supported session format.`,
    );
  }

  output.status(
    "→",
    output.dim(`Imported ${imported} session(s), skipped ${skipped}.`)
  );
}

/**
 * Entry point for `llmwiki ingest-session <pathOrDir>`.
 * Dispatches to single-file or directory import based on the target type.
 */
export default async function ingestSession(targetPath: string): Promise<void> {
  const root = process.cwd();
  const info = await stat(targetPath).catch(() => {
    throw new Error(`Path not found: ${targetPath}`);
  });

  if (info.isDirectory()) {
    await ingestDirectory(root, targetPath);
  } else {
    await ingestSessionFile(root, targetPath);
  }

  output.status("→", output.dim("Next: llmwiki compile"));
}

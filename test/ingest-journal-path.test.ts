/**
 * Journal references must remain portable Markdown paths even when ingestion
 * writes to a native Windows filesystem. Real filesystem operations stay native.
 */
import path from "node:path";
import { expect, it } from "vitest";
import { journalSavedPath } from "../src/commands/ingest.js";

it.each([
  { platform: "Windows", pathApi: path.win32, savedPath: "C:\\project\\sources\\a.md" },
  { platform: "POSIX", pathApi: path.posix, savedPath: "/project/sources/a.md" },
])("uses forward slashes for a $platform journal reference", ({ pathApi, savedPath }) => {
  expect(journalSavedPath(savedPath, pathApi)).toBe("sources/a.md");
});

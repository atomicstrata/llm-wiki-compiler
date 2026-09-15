/**
 * Shared source discovery: regular files with stable POSIX-relative
 * keys. Excluded directories are pruned before walking; symlinks are not sources.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { resolveSourcesDir } from "../utils/path-confine.js";
import { isSourceExcluded, loadSourceSelection, type SourceSelection } from "./selection.js";

/** Selected real files plus skipped aliases for inventory diagnostics. */
interface SourceScan {
  files: string[];
  symlinks: string[];
}

/** Walk selected real directories, preserving dot-files and exact relative names. */
async function walkSources(directory: string, prefix: string, selection: SourceSelection): Promise<SourceScan> {
  const result: SourceScan = { files: [], symlinks: [] };
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const id = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (isSourceExcluded(id, selection)) continue;
    if (entry.isFile()) result.files.push(id);
    else if (entry.isSymbolicLink()) result.symlinks.push(id);
    else if (entry.isDirectory() && selection.recursive) {
      const nested = await walkSources(path.join(directory, entry.name), id, selection);
      result.files.push(...nested.files);
      result.symlinks.push(...nested.symlinks);
    }
  }
  return result;
}

/** Scan without following aliases; absent/untrusted sources roots yield no entries. */
export async function scanSelectedSources(root: string, selection?: SourceSelection): Promise<SourceScan> {
  const policy = selection ?? await loadSourceSelection(root);
  const directory = await resolveSourcesDir(root);
  if (directory === null) return { files: [], symlinks: [] };
  const result = await walkSources(directory, "", policy);
  result.files.sort();
  result.symlinks.sort();
  return result;
}

/** List selected regular files, including raw non-Markdown viewer inventory. */
export async function listSelectedSourceEntries(root: string, selection?: SourceSelection): Promise<string[]> {
  return (await scanSelectedSources(root, selection)).files;
}

/** Markdown subset consumed by compilation and source-record inventory. */
export async function listSelectedSourceFiles(root: string, selection?: SourceSelection): Promise<string[]> {
  return (await listSelectedSourceEntries(root, selection)).filter((id) => id.endsWith(".md"));
}

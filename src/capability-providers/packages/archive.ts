/**
 * @file src/capability-providers/packages/archive.ts
 * @description Host-owned path grammar shared by provider tar/zip admission.
 * It rejects path escape, separator ambiguity, and platform aliases before any
 * archive entry can become a filesystem path.
 */
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import {
  MAX_EXPANDED_PACKAGE_TREE_BYTES, MAX_PACKAGE_ENTRIES, MAX_PACKAGE_ENTRY_BYTES,
} from "../constants.js";
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import {
  validateProviderArchivePath, verifyProviderTreeOnDisk, writeProviderTree,
  type ProviderTreeVerificationOptions, type ProviderTreeWriteOptions,
} from "./archive-filesystem.js";
import type { PlatformArtifactV1 } from "./protocol.js";

const TAR_BLOCK_BYTES = 512;

interface ArchiveEntry { readonly name: string; readonly body: Buffer; readonly directory: boolean }
interface TreeRecord { readonly path: string; readonly digest: string; readonly byteCount: number }

/** Summary of bytes admitted and durably extracted from one archive. */
export interface ExtractedProviderArchive {
  readonly expandedTreeDigest: string;
  readonly expandedByteCount: number;
  readonly entryCount: number;
}

/** Test seams for deterministic extraction-root and preflight coverage. */
export interface ExtractProviderArchiveOptions extends ProviderTreeWriteOptions {
  readonly maximumMaterializedEntriesForTest?: number;
}
export { validateProviderArchivePath } from "./archive-filesystem.js";

/** Validate, extract, fsync, and freeze one signed platform archive. */
export async function extractProviderArchive(
  archive: Buffer,
  artifact: PlatformArtifactV1,
  destination: string,
  options: ExtractProviderArchiveOptions = {},
): Promise<ExtractedProviderArchive> {
  assertArchiveBytes(archive, artifact);
  const parsed = artifact.archiveFormat === "tar" ? parseTar(archive) : parseZip(archive);
  const admitted = admitEntries(parsed, artifact, options.maximumMaterializedEntriesForTest);
  await writeProviderTree(destination, admitted.entries, artifact.entrypointRelativePath, options);
  return Object.freeze({
    expandedTreeDigest: admitted.digest,
    expandedByteCount: admitted.bytes,
    entryCount: admitted.entries.length,
  });
}

/** Rewalk an installed tree without following links and rebind its digest. */
export async function verifyProviderTree(
  root: string,
  artifact: PlatformArtifactV1,
  options: ProviderTreeVerificationOptions = {},
): Promise<ExtractedProviderArchive> {
  return verifyProviderTreeOnDisk(root, artifact, options);
}

function assertArchiveBytes(archive: Buffer, artifact: PlatformArtifactV1): void {
  if (!Buffer.isBuffer(archive) || archive.length !== artifact.archiveByteCount) {
    throw new Error("provider archive byte count differs from signed metadata");
  }
  const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  if (digest !== artifact.artifactDigest) throw new Error("provider archive digest differs from signed metadata");
}

function parseTar(archive: Buffer): ArchiveEntry[] {
  if (archive.length % TAR_BLOCK_BYTES !== 0) throw new Error("provider tar length is invalid");
  const entries: ArchiveEntry[] = [];
  let expandedBytes = 0;
  let offset = 0;
  while (offset + TAR_BLOCK_BYTES <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) {
      assertTarTerminator(archive, offset);
      break;
    }
    if (entries.length >= MAX_PACKAGE_ENTRIES) throw new Error("provider archive exceeds its entry cap");
    const parsed = parseTarEntry(archive, offset, header);
    if (!parsed.entry.directory) expandedBytes = reserveExpandedProviderBytes(expandedBytes, parsed.size);
    entries.push(parsed.entry);
    offset = parsed.nextOffset;
  }
  return entries;
}

function assertTarTerminator(archive: Buffer, offset: number): void {
  if (!archive.subarray(offset).every((byte) => byte === 0)) throw new Error("provider tar has trailing bytes");
}

function parseTarEntry(archive: Buffer, offset: number, header: Buffer) {
  assertTarChecksum(header);
  const name = tarText(header, 0, 100);
  const prefix = tarText(header, 345, 155);
  const size = tarOctal(header, 124, 12, "tar entry size");
  if (size > MAX_PACKAGE_ENTRY_BYTES) throw new Error("provider archive entry exceeds its byte cap");
  const bodyStart = offset + TAR_BLOCK_BYTES;
  const bodyEnd = bodyStart + size;
  if (bodyEnd > archive.length) throw new Error("provider tar entry is truncated");
  const directory = tarDirectory(header, size);
  return {
    entry: { name: prefix ? `${prefix}/${name}` : name, body: Buffer.from(archive.subarray(bodyStart, bodyEnd)), directory },
    size,
    nextOffset: bodyStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES,
  };
}

function tarDirectory(header: Buffer, size: number): boolean {
  const type = String.fromCharCode(header[156] || 48);
  if (type !== "0" && type !== "5") throw new Error("provider tar contains an unsupported leaf type");
  if (type === "5" && size !== 0) throw new Error("provider tar directory carries bytes");
  return type === "5";
}

function assertTarChecksum(header: Buffer): void {
  const expected = tarOctal(header, 148, 8, "tar checksum");
  let observed = 0;
  for (let index = 0; index < header.length; index += 1) {
    observed += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (observed !== expected) throw new Error("provider tar checksum is invalid");
}

function tarText(header: Buffer, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  const selected = end < 0 ? bytes : bytes.subarray(0, end);
  const value = selected.toString("utf8");
  if (Buffer.from(value, "utf8").compare(selected) !== 0) throw new Error("provider tar path is not valid UTF-8");
  return value;
}

function tarOctal(header: Buffer, start: number, length: number, label: string): number {
  const value = tarText(header, start, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error(`${label} is invalid`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function parseZip(archive: Buffer): ArchiveEntry[] {
  const eocd = findZipEocd(archive);
  const count = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (count > MAX_PACKAGE_ENTRIES) throw new Error("provider archive exceeds its entry cap");
  if (centralOffset + centralSize > eocd) throw new Error("provider zip directory is invalid");
  const entries: ZipCentralEntry[] = [];
  let offset = centralOffset;
  let expandedBytes = 0;
  for (let index = 0; index < count; index += 1) {
    const parsed = parseZipCentralEntry(archive, offset);
    expandedBytes = reserveExpandedProviderBytes(expandedBytes, parsed.size);
    entries.push(parsed);
    offset = parsed.nextOffset;
  }
  if (offset !== centralOffset + centralSize) throw new Error("provider zip directory size is inconsistent");
  return entries.map((entry) => zipEntryBody(archive, entry));
}

interface ZipCentralEntry {
  readonly name: string; readonly flags: number; readonly method: number;
  readonly crc: number; readonly compressedSize: number; readonly size: number;
  readonly externalAttributes: number; readonly localOffset: number; readonly nextOffset: number;
}

function parseZipCentralEntry(archive: Buffer, offset: number): ZipCentralEntry {
  if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("provider zip central entry is invalid");
  const flags = archive.readUInt16LE(offset + 8);
  const method = archive.readUInt16LE(offset + 10);
  const compressedSize = archive.readUInt32LE(offset + 20);
  const size = archive.readUInt32LE(offset + 24);
  const nameLength = archive.readUInt16LE(offset + 28);
  const extraLength = archive.readUInt16LE(offset + 30);
  const commentLength = archive.readUInt16LE(offset + 32);
  const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
  if (size > MAX_PACKAGE_ENTRY_BYTES) throw new Error("provider archive entry exceeds its byte cap");
  if ((flags & ~0x0800) !== 0 || (method !== 0 && method !== 8) || nextOffset > archive.length) {
    throw new Error("provider zip entry uses unsupported features");
  }
  return {
    name: zipText(archive.subarray(offset + 46, offset + 46 + nameLength)),
    flags, method, crc: archive.readUInt32LE(offset + 16), compressedSize, size,
    externalAttributes: archive.readUInt32LE(offset + 38),
    localOffset: archive.readUInt32LE(offset + 42), nextOffset,
  };
}

function zipEntryBody(archive: Buffer, central: ZipCentralEntry): ArchiveEntry {
  const { name, compressed } = readZipLocalBody(archive, central);
  const body = central.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_PACKAGE_ENTRY_BYTES });
  if (body.length !== central.size || crc32(body) !== central.crc) throw new Error("provider zip entry bytes are invalid");
  return { name, body, directory: zipDirectory(central, name, body.length) };
}

function readZipLocalBody(archive: Buffer, central: ZipCentralEntry) {
  const offset = central.localOffset;
  if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== 0x04034b50) throw new Error("provider zip local entry is invalid");
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  const name = zipText(archive.subarray(offset + 30, offset + 30 + nameLength));
  const bodyStart = offset + 30 + nameLength + extraLength;
  const compressed = archive.subarray(bodyStart, bodyStart + central.compressedSize);
  const observed = [name, archive.readUInt16LE(offset + 6), archive.readUInt16LE(offset + 8),
    archive.readUInt32LE(offset + 14), archive.readUInt32LE(offset + 18),
    archive.readUInt32LE(offset + 22), compressed.length];
  const expected = [central.name, central.flags, central.method, central.crc,
    central.compressedSize, central.size, central.compressedSize];
  if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error("provider zip local and central entries differ");
  return { name, compressed };
}

function zipDirectory(central: ZipCentralEntry, name: string, bodyLength: number): boolean {
  const unixType = (central.externalAttributes >>> 16) & 0o170000;
  const directory = name.endsWith("/");
  if (directory && bodyLength !== 0) throw new Error("provider zip directory carries bytes");
  if (unixType !== 0 && unixType !== 0o100000 && !(directory && unixType === 0o040000)) {
    throw new Error("provider zip contains an unsupported leaf type");
  }
  return directory;
}

function zipText(bytes: Buffer): string {
  const value = bytes.toString("utf8");
  if (Buffer.from(value, "utf8").compare(bytes) !== 0) throw new Error("provider zip path is not valid UTF-8");
  return value;
}

function findZipEocd(archive: Buffer): number {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      if (archive.readUInt16LE(offset + 4) !== 0 || archive.readUInt16LE(offset + 6) !== 0
        || archive.readUInt16LE(offset + 8) !== archive.readUInt16LE(offset + 10)) break;
      if (offset + 22 + archive.readUInt16LE(offset + 20) !== archive.length) break;
      return offset;
    }
  }
  throw new Error("provider zip end record is missing");
}

function admitEntries(
  entries: readonly ArchiveEntry[],
  artifact: PlatformArtifactV1,
  maximumEntriesForTest?: number,
) {
  const roots = new Set<string>();
  const collisions = new Set<string>();
  const files: Array<ArchiveEntry & { relative: string }> = [];
  for (const entry of entries) {
    const admitted = admitEntry(entry, roots, collisions);
    if (admitted) files.push(admitted);
  }
  if (roots.size !== 1) throw new Error("provider archive must contain one package root");
  assertMaterializedEntryBudget(files, maximumEntriesForTest);
  const bytes = files.reduce((sum, entry) => sum + entry.body.length, 0);
  if (bytes > MAX_EXPANDED_PACKAGE_TREE_BYTES) throw new Error("provider archive expanded bytes exceed the cap");
  const digest = canonicalDigest(files.map(treeRecord).sort(compareRecord));
  assertAdmittedClaims(files, bytes, digest, artifact);
  return { entries: files, bytes, digest };
}

function assertMaterializedEntryBudget(
  files: ReadonlyArray<ArchiveEntry & { relative: string }>,
  maximumForTest?: number,
): void {
  const maximum = maximumForTest ?? MAX_PACKAGE_ENTRIES;
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > MAX_PACKAGE_ENTRIES) {
    throw new Error("provider archive test entry ceiling is invalid");
  }
  if (files.length > maximum) throw new Error("provider archive materialized tree exceeds its entry cap");
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.relative.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
      if (files.length + directories.size > maximum) {
        throw new Error("provider archive materialized tree exceeds its entry cap");
      }
    }
  }
}

function admitEntry(
  entry: ArchiveEntry,
  roots: Set<string>,
  collisions: Set<string>,
): (ArchiveEntry & { relative: string }) | null {
  const parts = validateProviderArchivePath(entry.name);
  roots.add(parts[0]);
  const collision = parts.join("/").normalize("NFC").toLowerCase();
  if (collisions.has(collision)) throw new Error("provider archive contains a path collision");
  collisions.add(collision);
  const relative = parts.slice(1).join("/");
  if (relative === "" && !entry.directory) throw new Error("provider archive package root must be a directory");
  return relative !== "" && !entry.directory ? { ...entry, relative } : null;
}

function assertAdmittedClaims(
  files: ReadonlyArray<ArchiveEntry & { relative: string }>,
  bytes: number,
  digest: string,
  artifact: PlatformArtifactV1,
): void {
  if (files.length !== artifact.entryCount || bytes !== artifact.expandedByteCount || digest !== artifact.expandedTreeDigest) {
    throw new Error("provider archive expanded tree differs from signed metadata");
  }
  if (!files.some((entry) => entry.relative === artifact.entrypointRelativePath)) {
    throw new Error("provider archive entrypoint is undeclared or absent");
  }
}

function compareRecord(left: TreeRecord, right: TreeRecord): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function treeRecord(entry: ArchiveEntry & { relative: string }): TreeRecord {
  return {
    path: entry.relative,
    digest: `sha256:${createHash("sha256").update(entry.body).digest("hex")}`,
    byteCount: entry.body.length,
  };
}

/** Reserve aggregate expanded bytes before reading or inflating a body. */
export function reserveExpandedProviderBytes(current: number, next: number): number {
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(next) || current < 0 || next < 0
    || current > MAX_EXPANDED_PACKAGE_TREE_BYTES - next) {
    throw new Error("provider archive expanded bytes exceed the cap");
  }
  return current + next;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

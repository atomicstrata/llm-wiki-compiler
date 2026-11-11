/**
 * One pinned artifact, resolved against the store on every render: its file
 * check, manifest and declared metadata, and a download link when the bytes
 * are available here. Content is never rendered as HTML; a download is the
 * only way at the bytes.
 */
import type { ReactNode } from "react";
import { artifactDownloadUrl, artifactRef, fetchArtifact, type ArtifactMetadata, type ArtifactPin } from "./api-workflows";
import { Code, DefinitionRows, Disclosure, TextLink } from "./components";
import { humanLabel } from "./wiki-model";
import { useAsync } from "./use-async";

/** What each file check means, without equating an unknown status with a verified file. */
const FILE_HEALTH_LABELS: Record<string, string> = {
  ok: "Passed",
  "artifact-dangling": "Attached file not found",
  "artifact-unreadable": "Attached file could not be read",
  "artifact-bytes-tampered": "File contents have changed",
  "artifact-schema-invalid": "File contents do not match the expected format",
  "artifact-hash-mismatch": "File does not match the attached version",
  "artifact-store-unavailable": "File storage could not be verified",
};

const LOOPBACK_NOTE = "To preview files, run the viewer bound to localhost on the computer storing this project.";

/** The declared metadata keys the server allowed through, as a definition list. */
function FileMetadata({ metadata }: { metadata: Record<string, unknown> }): ReactNode {
  const entries = Object.entries(metadata);
  if (entries.length === 0) return null;
  const rows = entries.map(([key, value]): [string, ReactNode] => [humanLabel(key), typeof value === "object" ? JSON.stringify(value) : String(value)]);
  return <div className="mt-2 border-t border-zinc-950/5 pt-2 dark:border-white/10"><DefinitionRows rows={rows} /></div>;
}

/** The file check, and the manifest's size and write time when there is one. */
function checkRows(metadata: ArtifactMetadata): [string, ReactNode][] {
  const rows: [string, ReactNode][] = [["File check", FILE_HEALTH_LABELS[metadata.health] ?? "File could not be verified"]];
  if (metadata.manifest) {
    rows.push(["Size", `${metadata.manifest.bytes} bytes · ${metadata.manifest.contentKind}`], ["Written", metadata.manifest.writtenAt]);
  }
  return rows;
}

/** The resolved artifact: name, file check, metadata, and the download when allowed. */
export function ArtifactDetail({ metadata }: { metadata: ArtifactMetadata }): ReactNode {
  const isOk = metadata.health === "ok";
  return (
    <div className="mt-4 rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-950/5 dark:bg-white/5 dark:ring-white/10">
      <strong className="mb-2 block text-sm font-semibold text-zinc-950 dark:text-white">{metadata.fileName ?? "Attached file"}</strong>
      <DefinitionRows rows={checkRows(metadata)} />
      {metadata.metadata && <FileMetadata metadata={metadata.metadata} />}
      {isOk && metadata.contentAccess === "available" && <p className="mt-3"><TextLink href={artifactDownloadUrl(metadata.ref)}>Download</TextLink></p>}
      {isOk && metadata.contentAccess === "loopback-only" && <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">{LOOPBACK_NOTE}</p>}
      <div className="mt-3">
        <Disclosure quiet summary="File reference"><p className="break-all"><Code>{metadata.ref}</Code></p></Disclosure>
      </div>
    </div>
  );
}

/** Resolve one pin and show what the store says about it; loading and failure are a quiet line inside the stage card. */
export function ArtifactRef({ pin }: { pin: ArtifactPin }): ReactNode {
  const ref = artifactRef(pin);
  const state = useAsync(() => fetchArtifact(ref), ref);
  if (state.status === "ready") return <ArtifactDetail metadata={state.data} />;
  return (
    <p role={state.status === "loading" ? "status" : undefined} className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
      {state.status === "loading" ? "Checking the attached file…" : "File could not be checked. Try reopening this record."}
    </p>
  );
}

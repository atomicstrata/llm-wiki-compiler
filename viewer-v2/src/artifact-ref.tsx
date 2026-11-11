/**
 * One pinned artifact, resolved against the store on every render: its file
 * check, manifest and declared metadata, and a download link when the bytes
 * are available here. Content is never rendered as HTML; a download is the
 * only way at the bytes.
 */
import type { ReactNode } from "react";
import { artifactDownloadUrl, artifactRef, fetchArtifact, type ArtifactMetadata, type ArtifactPin } from "./api-workflows";
import { AsyncView } from "./async-view";
import { displayLabel } from "./pipeline-model";
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
  return (
    <dl>
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{displayLabel(key)}</dt>
          <dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The resolved artifact: name, file check, metadata, and the download when allowed. */
export function ArtifactDetail({ metadata }: { metadata: ArtifactMetadata }): ReactNode {
  const isOk = metadata.health === "ok";
  return (
    <div>
      <strong>{metadata.fileName ?? "Attached file"}</strong>
      <dl>
        <div><dt>File check</dt><dd>{FILE_HEALTH_LABELS[metadata.health] ?? "File could not be verified"}</dd></div>
        {metadata.manifest && <div><dt>Size</dt><dd>{metadata.manifest.bytes} bytes · {metadata.manifest.contentKind}</dd></div>}
        {metadata.manifest && <div><dt>Written</dt><dd>{metadata.manifest.writtenAt}</dd></div>}
      </dl>
      {metadata.metadata && <FileMetadata metadata={metadata.metadata} />}
      {isOk && metadata.contentAccess === "available" && <a href={artifactDownloadUrl(metadata.ref)}>Download</a>}
      {isOk && metadata.contentAccess === "loopback-only" && <p>{LOOPBACK_NOTE}</p>}
      <details>
        <summary>File reference</summary>
        <code>{metadata.ref}</code>
      </details>
    </div>
  );
}

/** Resolve one pin and show what the store says about it. */
export function ArtifactRef({ pin }: { pin: ArtifactPin }): ReactNode {
  const ref = artifactRef(pin);
  const state = useAsync(() => fetchArtifact(ref), ref);
  if (state.status === "error") return <p>File could not be checked. Try reopening this record.</p>;
  return <AsyncView state={state}>{(metadata) => <ArtifactDetail metadata={metadata} />}</AsyncView>;
}

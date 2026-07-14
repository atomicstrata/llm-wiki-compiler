/**
 * @file test/fixtures/publisher-workspace.ts
 * @description Workspace paths and escape-planting helpers shared by the publisher
 * suites. Temp-root lifecycle reuses the existing managed-temp-roots fixture.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePaths, type WorkspacePaths } from "../../src/profile/templates/publish/workspace-paths.js";

export { managedTempRoots as publisherTempRoots } from "./managed-temp-roots.js";

/** A workspace directory with its `keys/` dir already present. */
export async function makeWorkspacePaths(root: string): Promise<WorkspacePaths> {
  const paths = resolveWorkspacePaths(root);
  await mkdir(paths.keysDir, { recursive: true, mode: 0o700 });
  return paths;
}

/** Write one file OUTSIDE the workspace, for symlink-escape coverage. */
export async function outsideFile(root: string, name: string, content: string): Promise<string> {
  const file = path.join(root, name);
  await writeFile(file, content, "utf8");
  return file;
}

/** A minimal, valid remote template package used by the publisher suites. */
export const PUBLISHER_TEMPLATE = {
  schemaVersion: 1,
  templateId: "incident-response",
  version: "1.0.0",
  displayName: "Incident Response",
  publisher: "acme",
  sourceType: "remote",
  license: "MIT",
  minLlmwikiVersion: "1.0.0",
  profile: {
    schemaVersion: 1,
    profileId: "incident-response",
    displayName: "Incident Response",
    entities: {
      incidents: {
        directory: "wiki/incidents",
        titleField: "title",
        requiredFields: ["title"],
        fields: { title: { type: "string" } },
      },
    },
  },
};

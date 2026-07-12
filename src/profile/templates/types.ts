/**
 * @file src/profile/templates/types.ts
 * @description DTOs for install-time profile template packages and advisory
 * template locks. These types deliberately describe declarative package data
 * only; template installation materializes a ProfilePack and then leaves the
 * runtime loader unchanged.
 */
import type { ProfilePack } from "../types.js";

/** Template source classes understood by package validation and provenance. */
export type TemplateSourceType = "builtin" | "local" | "remote";

/** Example bundle metadata. v0 permits only non-executable OKF examples. */
export interface TemplateExample {
  id: string;
  title: string;
  kind: "okf";
  path: string;
}

/** An installable declarative profile-template package. */
export interface ProfileTemplatePackage {
  schemaVersion: 1;
  templateId: string;
  version: string;
  displayName: string;
  publisher: string;
  sourceType: TemplateSourceType;
  license: string;
  minLlmwikiVersion: string;
  description?: string;
  profile: ProfilePack;
  docs?: string;
  examples?: TemplateExample[];
}

/** Legacy advisory provenance written by llmwiki 1.0. */
export interface TemplateLockV1 {
  schemaVersion: 1;
  templateId: string;
  version: string;
  publisher: string;
  sourceType: TemplateSourceType;
  installedAt: string;
  profileDigest: string;
}

/** Verified remote release locator recorded by future remote installs. */
export interface RemoteTemplateProvenance {
  coordinate: string;
  packageDigest: string;
  tap: string;
  indexSequence: number;
  publisherKeyId: string;
  verifiedAt: string;
}

/** Current advisory provenance. Runtime profile loading never reads this file. */
export interface TemplateLockV2 {
  schemaVersion: 2;
  templateId: string;
  version: string;
  publisher: string;
  sourceType: TemplateSourceType;
  installedAt: string;
  profileDigest: string;
  remote?: RemoteTemplateProvenance;
}

/** Every advisory lock schema accepted by the reader. */
export type TemplateLock = TemplateLockV1 | TemplateLockV2;

/** User-facing summary for builtin template list/inspect output. */
export interface ProfileTemplateSummary {
  templateId: string;
  profileId: string;
  displayName: string;
  version: string | null;
  publisher: string;
  sourceType: TemplateSourceType;
  installable: boolean;
  capabilities: DerivedTemplateCapabilities;
}

/** Capabilities derived from a validated ProfilePack. */
export interface DerivedTemplateCapabilities {
  entities: number;
  relations: number;
  workflows: number;
  workflowActions: number;
  artifacts: number;
  connectors: string[];
  contentTiers: boolean;
  relationPreconditions: boolean;
  artifactPreconditions: boolean;
}

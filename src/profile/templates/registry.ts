/**
 * @file src/profile/templates/registry.ts
 * @description Static registry for builtin install-time profile templates.
 */
import { deriveTemplateCapabilities } from "./capabilities.js";
import type { ProfileTemplatePackage, ProfileTemplateSummary } from "./types.js";
import { AUTOSCI_TEMPLATE } from "./builtin/autosci.js";
import { DEFAULT_TEMPLATE_SUMMARY } from "./builtin/default.js";
import { NEWSROOM_TEMPLATE } from "./builtin/newsroom.js";

// Retain historical releases here when a builtin advances. Secure update
// planning must resolve the exact installed release, not reinterpret it as the
// newest package carrying the same template id.
const BUILTIN_TEMPLATE_RELEASES: readonly ProfileTemplatePackage[] = [
  AUTOSCI_TEMPLATE,
  NEWSROOM_TEMPLATE,
];

/** List inspectable builtin template summaries. */
export function listBuiltinTemplates(): readonly ProfileTemplateSummary[] {
  return [
    DEFAULT_TEMPLATE_SUMMARY,
    ...latestBuiltinTemplates().map(summaryFor),
  ];
}

/** Resolve an installable builtin template by id. `default` is intentionally absent. */
export function getBuiltinTemplate(id: string): ProfileTemplatePackage | undefined {
  return latestBuiltinTemplates().find((template) => template.templateId === id);
}

/** Resolve one immutable builtin release by its complete published identity. */
export function getBuiltinTemplateRelease(
  id: string,
  version: string,
  publisher: string,
): ProfileTemplatePackage | undefined {
  return BUILTIN_TEMPLATE_RELEASES.find((template) =>
    template.templateId === id && template.version === version && template.publisher === publisher,
  );
}

function latestBuiltinTemplates(): ProfileTemplatePackage[] {
  const latest = new Map<string, ProfileTemplatePackage>();
  for (const release of BUILTIN_TEMPLATE_RELEASES) {
    const current = latest.get(release.templateId);
    if (!current || compareTemplateVersions(release.version, current.version) > 0) latest.set(release.templateId, release);
  }
  return [...latest.values()];
}

/** Compare validated SemVer strings when selecting the latest builtin release. */
export function compareTemplateVersions(left: string, right: string): number {
  const [leftVersion, leftPre] = versionParts(left);
  const [rightVersion, rightPre] = versionParts(right);
  const a = leftVersion.split(".").map(Number);
  const b = rightVersion.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return comparePrerelease(leftPre, rightPre);
}

function versionParts(version: string): [string, string | undefined] {
  const withoutBuild = version.split("+", 1)[0];
  const separator = withoutBuild.indexOf("-");
  return separator < 0
    ? [withoutBuild, undefined]
    : [withoutBuild.slice(0, separator), withoutBuild.slice(separator + 1)];
}

function comparePrerelease(left: string | undefined, right: string | undefined): number {
  const presence = comparePrereleasePresence(left, right);
  if (presence !== null) return presence;
  const a = left!.split(".");
  const b = right!.split(".");
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const result = comparePrereleaseIdentifier(a[index], b[index]);
    if (result !== 0) return result;
  }
  return a.length - b.length;
}

function comparePrereleasePresence(left: string | undefined, right: string | undefined): number | null {
  if (left !== undefined && right !== undefined) return null;
  if (left === right) return 0;
  return left === undefined ? 1 : -1;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  if (left === right) return 0;
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left.localeCompare(right);
}

/** Build one user-facing summary from a package. */
export function summaryFor(template: ProfileTemplatePackage): ProfileTemplateSummary {
  return {
    templateId: template.templateId,
    profileId: template.profile.profileId,
    displayName: template.displayName,
    version: template.version,
    publisher: template.publisher,
    sourceType: template.sourceType,
    installable: true,
    capabilities: deriveTemplateCapabilities(template.profile),
  };
}

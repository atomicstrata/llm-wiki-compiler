/**
 * @file src/profile/templates/validate.ts
 * @description Fail-closed validation for install-time profile template
 * packages. The validator accepts only declarative package metadata plus a
 * ProfilePack validated by the existing profile loader contract.
 */
import { getConnectorDef } from "../../connectors/registry.js";
import { isSlugSafe } from "../identity.js";
import { validateProfile } from "../validate.js";
import type { ProfileTemplatePackage, TemplateExample, TemplateSourceType } from "./types.js";

const PACKAGE_KEYS = new Set([
  "schemaVersion",
  "templateId",
  "version",
  "displayName",
  "description",
  "publisher",
  "sourceType",
  "license",
  "minLlmwikiVersion",
  "profile",
  "docs",
  "examples",
]);

/** Error raised when a template package cannot be installed. */
export class TemplatePackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplatePackageError";
  }
}

export interface TemplateValidationOptions {
  currentVersion: string;
  sourceType: TemplateSourceType;
}

/** Validate and normalize a raw template package. */
export function validateTemplatePackage(raw: unknown, options: TemplateValidationOptions): ProfileTemplatePackage {
  const obj = objectRecord(raw, "template package");
  rejectUnsupportedPackageKeys(obj);
  assertEqual(obj.schemaVersion, 1, "template schemaVersion must be 1");
  const templateId = slugString(obj.templateId, "templateId");
  const profile = validateProfile(obj.profile).profile;
  if (profile.profileId !== templateId) {
    throw new TemplatePackageError(`templateId must match profileId: ${templateId} !== ${profile.profileId}`);
  }
  const version = versionString(obj.version, "template version");
  const pkg: ProfileTemplatePackage = {
    schemaVersion: 1,
    templateId,
    version,
    displayName: nonEmptyString(obj.displayName, "displayName"),
    publisher: nonEmptyString(obj.publisher, "publisher"),
    sourceType: templateSourceType(obj.sourceType, options.sourceType),
    license: nonEmptyString(obj.license, "license"),
    minLlmwikiVersion: versionString(obj.minLlmwikiVersion, "template minLlmwikiVersion"),
    profile,
    ...optionalString(obj.description, "description"),
    ...optionalString(obj.docs, "docs"),
    ...optionalExamples(obj.examples),
  };
  assertVersionSupported(pkg.minLlmwikiVersion, options.currentVersion);
  assertConnectorBindingsResolvable(pkg);
  return pkg;
}

/** Ensure every connector binding points at a compiled-in, installable connector. */
function assertConnectorBindingsResolvable(pkg: ProfileTemplatePackage): void {
  for (const id of Object.keys(pkg.profile.connectors ?? {})) {
    const connector = getConnectorDef(id);
    if (!connector) throw new TemplatePackageError(`template connector ${JSON.stringify(id)} is not registered`);
    if (!connector.templateInstallable) {
      throw new TemplatePackageError(`template connector ${JSON.stringify(id)} is not installable in templates`);
    }
  }
}

function rejectUnsupportedPackageKeys(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (!PACKAGE_KEYS.has(key)) throw new TemplatePackageError(`unsupported template package field: ${key}`);
  }
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TemplatePackageError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertEqual(value: unknown, expected: unknown, message: string): void {
  if (value !== expected) throw new TemplatePackageError(message);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TemplatePackageError(`${field} must be a non-empty string`);
  }
  return value;
}

function slugString(value: unknown, field: string): string {
  const text = nonEmptyString(value, field);
  if (!isSlugSafe(text)) throw new TemplatePackageError(`${field} is not slug-safe: ${JSON.stringify(text)}`);
  return text;
}

function templateSourceType(value: unknown, expected: TemplateSourceType): TemplateSourceType {
  if (value === expected) return expected;
  throw new TemplatePackageError(`template sourceType must be ${expected} for this install source`);
}

function optionalString(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  return { [field]: nonEmptyString(value, field) };
}

function optionalExamples(value: unknown): { examples?: TemplateExample[] } {
  if (value === undefined) return {};
  if (!Array.isArray(value)) throw new TemplatePackageError("examples must be an array");
  return { examples: value.map(parseExample) };
}

function parseExample(raw: unknown): TemplateExample {
  const obj = objectRecord(raw, "template example");
  const kind = obj.kind;
  if (kind !== "okf") throw new TemplatePackageError("template example kind must be 'okf'");
  return {
    id: slugString(obj.id, "example.id"),
    title: nonEmptyString(obj.title, "example.title"),
    kind,
    path: safeRelativePath(obj.path, "example.path"),
  };
}

function safeRelativePath(value: unknown, field: string): string {
  const text = nonEmptyString(value, field);
  if (text.startsWith("/") || text.includes("\\") || text.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new TemplatePackageError(`${field} must be a safe relative path`);
  }
  if (!text.endsWith(".okf")) throw new TemplatePackageError(`${field} must point to an .okf bundle`);
  return text;
}

function parseVersionCore(value: string, label: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) throw new TemplatePackageError(`invalid ${label}: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionString(value: unknown, label: string): string {
  const text = nonEmptyString(value, label);
  parseVersionCore(text, label);
  return text;
}

function assertVersionSupported(minimum: string, current: string): void {
  const min = parseVersionCore(minimum, "template minLlmwikiVersion");
  let cur: [number, number, number];
  try {
    cur = parseVersionCore(current, "current llmwiki version");
  } catch {
    throw new TemplatePackageError(`template requires llmwiki >= ${minimum}; current version is ${current}`);
  }
  for (let i = 0; i < 3; i++) {
    if (cur[i] > min[i]) return;
    if (cur[i] < min[i]) throw new TemplatePackageError(`template requires llmwiki >= ${minimum}; current version is ${current}`);
  }
}

/**
 * @file src/commands/template.ts
 * @description Command handlers for install-time profile templates. These
 * handlers keep all template behavior routed through the existing builtin
 * registry, digest helper, and installer APIs so the CLI never becomes a
 * second authority for template data or profile-write semantics.
 */
import * as output from "../utils/output.js";
import { profileDigest } from "../profile/digest.js";
import {
  installBuiltinTemplate,
  installLocalTemplate,
  installRemoteTemplate,
} from "../profile/templates/install.js";
import { getBuiltinTemplate, listBuiltinTemplates, summaryFor } from "../profile/templates/registry.js";
import { deriveTemplateCapabilities } from "../profile/templates/capabilities.js";
import {
  confirmTemplateMutation,
  processTemplateConfirmationIo,
  type TemplateConfirmationIo,
} from "../profile/templates/confirm.js";
import { resolveRemotePackage, type ResolvedRemotePackage } from "../profile/templates/taps/package.js";
import { resolveTapPaths } from "../profile/templates/taps/paths.js";
import { collectTemplateStatus, type TemplateStatus } from "../profile/templates/status.js";
import { planBuiltinTemplateUpdate, type TemplateUpdatePlan } from "../profile/templates/update.js";
import { planRemoteTemplateUpdate } from "../profile/templates/remote-lifecycle.js";
import { applyRemoteTemplateUpdate } from "../profile/templates/update-apply.js";
import type { DerivedTemplateCapabilities, ProfileTemplateSummary } from "../profile/templates/types.js";

type InitSource = { kind: "id"; id: string } | { kind: "file"; path: string };
type CapabilityRow = { enabled: boolean; label: string };
type InspectDetails = ProfileTemplateSummary & {
  digest: string;
  license: string;
  minVersion: string;
};

/** Options accepted by `llmwiki template init`. */
export interface TemplateInitOptions {
  file?: string;
  force?: boolean;
  yes?: boolean;
  json?: boolean;
}

/** Options accepted by `llmwiki template status`. */
export interface TemplateStatusOptions {
  json?: boolean;
}

/** Options accepted by the read-only R1 update planner. */
export interface TemplateUpdateOptions {
  dryRun?: boolean;
  json?: boolean;
  to?: string;
  yes?: boolean;
}

/** Print all inspectable builtin template summaries. */
export async function templateListCommand(): Promise<void> {
  console.log("Template     Source    Version  Publisher      Capabilities");
  for (const summary of listBuiltinTemplates()) {
    console.log(formatSummaryRow(summary));
  }
}

/** Print one builtin template's metadata and derived capability summary. */
export async function templateInspectCommand(id: string): Promise<void> {
  const details = inspectDetails(id);
  if (!details) throw new Error(`Unknown template: ${id}`);
  output.header(`Template ${details.templateId}`);
  printTemplateMetadata(details);
  printCapabilityDetails(details.capabilities);
  console.log(`install:    ${formatInstallCommand(details)}`);
}

/** Install a builtin or local template into the current project root. */
export async function templateInitCommand(
  id: string | undefined,
  options: TemplateInitOptions,
  confirmationIo: TemplateConfirmationIo = processTemplateConfirmationIo(),
): Promise<number> {
  const source = initSource(id, options.file);
  if (source.kind === "id" && source.id.includes("/")) {
    return remoteInit(source.id, options, confirmationIo);
  }
  const result = source.kind === "file"
    ? await installLocalTemplate(process.cwd(), source.path, { force: Boolean(options.force) })
    : await installBuiltinTemplate(process.cwd(), source.id, { force: Boolean(options.force) });
  output.status("+", output.success(`Installed template '${result.templateId}' ${result.version}`));
  console.log("wrote .llmwiki/profile.json");
  printLockResult(result.lockWritten);
  console.log("next: llmwiki profile validate");
  return 0;
}

async function remoteInit(
  coordinate: string,
  options: TemplateInitOptions,
  confirmationIo: TemplateConfirmationIo,
): Promise<number> {
  const paths = resolveTapPaths();
  const resolved = await resolveRemotePackage(paths, coordinate);
  const summary = remoteInstallSummary(resolved);
  const confirmed = options.yes === true
    || await confirmTemplateMutation(formatRemoteInstallConfirmation(summary), confirmationIo);
  if (!confirmed) throw new Error("remote template install requires interactive confirmation or --yes");
  const result = await installRemoteTemplate(process.cwd(), paths, resolved, { force: Boolean(options.force) });
  if (options.json) console.log(JSON.stringify({ ...summary, ...result }, null, 2));
  else printRemoteInstallResult(summary, result.lockWritten);
  return 0;
}

/** Build the complete operator-review summary from verified release evidence. */
export function remoteInstallSummary(resolved: ResolvedRemotePackage) {
  return {
    coordinate: resolved.coordinate,
    payloadDigest: resolved.payloadDigest,
    publisherKeyId: resolved.publisherKeyId,
    tapSequence: resolved.tapSequence,
    capabilities: deriveTemplateCapabilities(resolved.package.profile),
  };
}

/** Format every security- and behavior-relevant remote install fact before confirmation. */
export function formatRemoteInstallConfirmation(summary: ReturnType<typeof remoteInstallSummary>): string {
  return [
    `Install verified remote template ${summary.coordinate}?`,
    `Digest: ${summary.payloadDigest}`,
    `Publisher key: ${summary.publisherKeyId}`,
    `Tap sequence: ${summary.tapSequence}`,
    `Connector bindings: ${summary.capabilities.connectors.join(", ") || "none"}`,
    `Capabilities: ${formatCapabilities(summary.capabilities)}`,
  ].join("\n");
}

function printRemoteInstallResult(summary: ReturnType<typeof remoteInstallSummary>, lockWritten: boolean): void {
  output.status("+", output.success(`Installed verified remote template ${summary.coordinate}`));
  console.log(`digest:       ${summary.payloadDigest}`);
  console.log(`publisherKey: ${summary.publisherKeyId}`);
  console.log(`tapSequence:  ${summary.tapSequence}`);
  console.log(`connectors:   ${summary.capabilities.connectors.join(", ") || "-"}`);
  printLockResult(lockWritten);
  console.log("next: llmwiki profile validate");
}

/** Report installed-template provenance and active-profile drift. */
export async function templateStatusCommand(options: TemplateStatusOptions): Promise<number> {
  const status = await collectTemplateStatus(process.cwd());
  if (options.json) console.log(JSON.stringify(status, null, 2));
  else printTemplateStatus(status);
  return status.status === "installed-clean" || status.status === "untracked" ? 0 : 1;
}

/** Preview a compatible builtin update; R1 deliberately performs no write. */
export async function templateUpdateCommand(
  id: string | undefined,
  options: TemplateUpdateOptions,
  confirmationIo: TemplateConfirmationIo = processTemplateConfirmationIo(),
): Promise<number> {
  if (options.to) {
    if (id !== undefined) throw new Error("remote template update derives identity from installed provenance; omit [id]");
    return remoteUpdate(options, confirmationIo);
  }
  return builtinUpdate(id, options);
}

async function builtinUpdate(id: string | undefined, options: TemplateUpdateOptions): Promise<number> {
  assertBuiltinUpdateOptions(options);
  const plan = await planBuiltinTemplateUpdate(process.cwd(), id);
  return printBuiltinPreview(plan, options.json === true);
}

function assertBuiltinUpdateOptions(options: TemplateUpdateOptions): void {
  if (!options.dryRun) throw new Error("builtin template update is preview-only; pass --dry-run");
  if (options.yes) throw new Error("--yes requires a remote --to <version> update");
}

function printBuiltinPreview(plan: TemplateUpdatePlan, json: boolean): number {
  if (json) console.log(JSON.stringify(plan, null, 2));
  else printUpdatePlan(plan);
  return plan.compatible ? 0 : 1;
}

async function remoteUpdate(
  options: TemplateUpdateOptions,
  confirmationIo: TemplateConfirmationIo,
): Promise<number> {
  const paths = resolveTapPaths();
  const plan = await planRemoteTemplateUpdate(process.cwd(), paths, options.to!);
  const previewResult = requestedRemotePreview(plan, options);
  if (previewResult !== null) return previewResult;
  return applyConfirmedRemoteUpdate(plan, paths, options, confirmationIo);
}

function requestedRemotePreview(
  plan: Awaited<ReturnType<typeof planRemoteTemplateUpdate>>,
  options: TemplateUpdateOptions,
): number | null {
  if (options.dryRun || !plan.compatible) return printRemotePreview(plan, options.json === true);
  return null;
}

async function applyConfirmedRemoteUpdate(
  plan: Awaited<ReturnType<typeof planRemoteTemplateUpdate>>,
  paths: ReturnType<typeof resolveTapPaths>,
  options: TemplateUpdateOptions,
  confirmationIo: TemplateConfirmationIo,
): Promise<number> {
  if (!options.yes) printRemotePreview(plan, false);
  await requireRemoteUpdateConfirmation(plan, options.yes === true, confirmationIo);
  const result = await applyRemoteTemplateUpdate(process.cwd(), paths, options.to!);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else output.status("+", output.success(`Updated ${result.fromCoordinate} -> ${result.toCoordinate}`));
  return 0;
}

function printRemotePreview(plan: Awaited<ReturnType<typeof planRemoteTemplateUpdate>>, json: boolean): number {
  if (json) console.log(JSON.stringify(plan, null, 2));
  else printUpdatePlan(plan);
  return plan.compatible ? 0 : 1;
}

async function requireRemoteUpdateConfirmation(
  plan: Awaited<ReturnType<typeof planRemoteTemplateUpdate>>,
  confirmedByFlag: boolean,
  confirmationIo: TemplateConfirmationIo,
): Promise<void> {
  if (confirmedByFlag) return;
  const confirmed = await confirmTemplateMutation(`Update ${plan.fromCoordinate} to ${plan.toCoordinate}?`, confirmationIo);
  if (!confirmed) throw new Error("remote template update requires interactive confirmation or --yes");
}

function printUpdatePlan(plan: TemplateUpdatePlan): void {
  output.header(`Template update ${plan.from} -> ${plan.to}`);
  console.log(`compatible: ${plan.compatible}`);
  if (plan.reasons.length === 0) console.log("no compatibility blockers");
  for (const reason of plan.reasons) console.log(`- ${reason.kind}: ${reason.path ? `${reason.path}: ` : ""}${reason.message}`);
}

function printTemplateStatus(status: TemplateStatus): void {
  output.header("Template status");
  console.log(`status:     ${status.status}`);
  console.log(`profileId:  ${status.profileId}`);
  console.log(`templateId: ${status.templateId ?? "-"}`);
  console.log(`version:    ${status.installedVersion ?? "-"}`);
  console.log(`detail:     ${status.detail}`);
}

function findBuiltinSummary(id: string): ProfileTemplateSummary | undefined {
  return listBuiltinTemplates().find((entry) => entry.templateId === id);
}

function inspectDetails(id: string): InspectDetails | undefined {
  const builtin = getBuiltinTemplate(id);
  if (builtin) return inspectableBuiltin(builtin);
  const summary = findBuiltinSummary(id);
  if (!summary) return undefined;
  return { ...summary, digest: "-", license: "-", minVersion: "-" };
}

function inspectableBuiltin(builtin: NonNullable<ReturnType<typeof getBuiltinTemplate>>): InspectDetails {
  return {
    ...summaryFor(builtin),
    digest: profileDigest(builtin.profile),
    license: builtin.license,
    minVersion: builtin.minLlmwikiVersion,
  };
}

function printTemplateMetadata(details: InspectDetails): void {
  console.log(`templateId: ${details.templateId}`);
  console.log(`profileId:  ${details.profileId}`);
  console.log(`display:    ${details.displayName}`);
  console.log(`version:    ${details.version ?? "-"}`);
  console.log(`license:    ${details.license}`);
  console.log(`minVersion: ${details.minVersion}`);
  console.log(`publisher:  ${details.publisher}`);
  console.log(`source:     ${details.sourceType}`);
  console.log(`digest:     ${details.digest}`);
}

function printCapabilityDetails(capabilities: DerivedTemplateCapabilities): void {
  console.log(`connectors: ${capabilities.connectors.join(", ") || "-"}`);
  console.log(`entities:   ${capabilities.entities}`);
  console.log(`relations:  ${capabilities.relations}`);
  console.log(`workflows:  ${capabilities.workflows}`);
  console.log(`workflowActions: ${capabilities.workflowActions}`);
  console.log(`artifacts:  ${capabilities.artifacts}`);
  console.log(`contentTiers: ${capabilities.contentTiers}`);
  console.log(`relationPreconditions: ${capabilities.relationPreconditions}`);
  console.log(`artifactPreconditions: ${capabilities.artifactPreconditions}`);
}

function initSource(id: string | undefined, file: string | undefined): InitSource {
  const sources = [idSource(id), fileSource(file)].filter(isInitSource);
  if (sources.length !== 1) throw new Error("template init requires exactly one template id or --file <path>");
  return sources[0];
}

function idSource(id: string | undefined): InitSource | undefined {
  return nonEmptyString(id) ? { kind: "id", id } : undefined;
}

function fileSource(file: string | undefined): InitSource | undefined {
  return nonEmptyString(file) ? { kind: "file", path: file } : undefined;
}

function isInitSource(source: InitSource | undefined): source is InitSource {
  return source !== undefined;
}

function nonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function printLockResult(lockWritten: boolean): void {
  if (lockWritten) {
    console.log("wrote .llmwiki/template-lock.json");
    return;
  }
  output.note(output.warn("warning: installed profile, but advisory template-lock.json could not be written"));
}

function formatSummaryRow(summary: ProfileTemplateSummary): string {
  return `${summary.templateId.padEnd(12)} ${summary.sourceType.padEnd(9)} ${(summary.version ?? "-").padEnd(8)} ${summary.publisher.padEnd(14)} ${formatCapabilities(summary.capabilities)}`;
}

function formatCapabilities(capabilities: DerivedTemplateCapabilities): string {
  return capabilityRows(capabilities)
    .filter((row) => row.enabled)
    .map((row) => row.label)
    .join(" ");
}

function capabilityRows(capabilities: DerivedTemplateCapabilities): CapabilityRow[] {
  return [
    { enabled: true, label: `entities:${capabilities.entities}` },
    countRow("relations", capabilities.relations),
    countRow("workflows", capabilities.workflows),
    countRow("workflowActions", capabilities.workflowActions),
    countRow("artifacts", capabilities.artifacts),
    flagRow("contentTiers", capabilities.contentTiers),
    flagRow("relationPreconditions", capabilities.relationPreconditions),
    flagRow("artifactPreconditions", capabilities.artifactPreconditions),
    connectorsRow(capabilities.connectors),
  ];
}

function countRow(name: string, count: number): CapabilityRow {
  return { enabled: count > 0, label: `${name}:${count}` };
}

function flagRow(name: string, enabled: boolean): CapabilityRow {
  return { enabled, label: name };
}

function connectorsRow(connectors: string[]): CapabilityRow {
  return { enabled: connectors.length > 0, label: `connectors:${connectors.join(",")}` };
}

function formatInstallCommand(summary: ProfileTemplateSummary): string {
  return summary.installable ? `llmwiki template init ${summary.templateId}` : "not installable";
}

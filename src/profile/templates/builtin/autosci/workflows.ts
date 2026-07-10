/**
 * @file src/profile/templates/builtin/autosci/workflows.ts
 * @description Workflow and action definitions for the shipped AutoSci profile
 * template.
 */
import type { ProfilePack } from "../../../types.js";

/** AutoSci workflows copied from the reviewed research proof fixture. */
export const autosciWorkflows = {
  "literature-review": {
    stages: [
      { id: "gather-paper", reads: ["papers"], writes: ["papers"], gate: "trust:high" },
      { id: "extract-concept", reads: ["papers"], writes: ["research-concepts"] },
      { id: "link-concept", reads: ["research-concepts", "papers"], writes: ["research-concepts", "papers"], gate: "trust:high" },
      { id: "synthesize-topic", reads: ["research-concepts"], writes: ["topics"], gate: "human:curated" },
    ],
  },
  research: {
    stages: [
      { id: "import-paper", reads: ["papers"], writes: ["papers"], gate: "trust:high" },
      { id: "triage-paper", reads: ["papers"], writes: ["papers"] },
      { id: "distill-paper", reads: ["papers"], writes: ["papers"] },
      { id: "write-idea", reads: ["papers"], writes: ["ideas"] },
      { id: "link-idea", reads: ["ideas", "papers"], writes: ["ideas", "papers"] },
      { id: "write-experiment", reads: ["ideas"], writes: ["experiments"] },
      { id: "start-experiment", reads: ["experiments"], writes: ["experiments"] },
      { id: "link-experiment", reads: ["experiments", "ideas"], writes: ["experiments", "ideas"] },
      { id: "complete-experiment", reads: ["experiments", "ideas"], writes: ["experiments"] },
    ],
    projectionFile: "wiki/outputs/workflows/research-run.md",
  },
  "manuscript-writing": {
    stages: [
      { id: "draft-manuscript", reads: ["experiments", "research-outputs"], writes: ["manuscripts"] },
      { id: "cite-paper", reads: ["manuscripts", "papers"], writes: ["manuscripts", "papers"] },
      { id: "check-manuscript", reads: ["manuscripts"], writes: ["manuscripts"] },
      { id: "submit-manuscript", reads: ["manuscripts"], writes: ["manuscripts"] },
    ],
  },
  "experiment-design": {
    stages: [
      { id: "propose-method", reads: ["ideas", "methods"], writes: ["methods"] },
      { id: "design-experiment", reads: ["ideas", "methods"], writes: ["experiments"], gate: "agent:reviewed" },
      { id: "link-method", reads: ["experiments", "methods"], writes: ["experiments", "methods"] },
    ],
  },
  "review-response": {
    stages: [
      { id: "intake-review", reads: ["reviews"], writes: ["reviews"] },
      { id: "draft-response", reads: ["reviews", "manuscripts"], writes: ["research-outputs"], gate: "human:addressed" },
      { id: "link-response", reads: ["research-outputs", "reviews"], writes: ["research-outputs", "reviews"] },
    ],
  },
} satisfies NonNullable<ProfilePack["workflows"]>;

/** AutoSci workflow actions copied from the reviewed research proof fixture. */
export const autosciWorkflowActions = {
  "research.begin": {
    label: "Begin research",
    workflow: "research",
    operation: "start",
    trustGate: "trust:high",
    permissions: { cli: "trusted-write", sdk: "trusted-write", mcp: "trusted-write", viewer: "read-only" },
  },
  "research.check": {
    label: "Check research runs",
    workflow: "research",
    operation: "status",
    permissions: { cli: "read-only", sdk: "read-only", mcp: "read-only", viewer: "read-only" },
  },
  "research.step": {
    label: "Advance research",
    workflow: "research",
    operation: "advance",
    trustGate: "trust:high",
    inputSchema: { runId: { type: "string", required: true } },
    permissions: { cli: "staged-write", sdk: "staged-write", mcp: "staged-write", viewer: "disabled" },
  },
  "literature.file-paper": {
    label: "File a paper",
    workflow: "literature-review",
    operation: "submit",
    trustGate: "trust:high",
    inputSchema: {
      runId: { type: "string", required: true },
      entityType: { type: "string", required: true },
      slug: { type: "string", required: true },
      body: { type: "string", required: true },
    },
    permissions: { cli: "trusted-write", sdk: "trusted-write", mcp: "staged-write", viewer: "disabled" },
  },
  "review-response.approve": {
    label: "Approve a review response",
    workflow: "review-response",
    operation: "gate",
    gate: "human:addressed",
    inputSchema: { runId: { type: "string", required: true } },
    permissions: { cli: "trusted-write", sdk: "trusted-write", mcp: "staged-write", viewer: "disabled" },
  },
} satisfies NonNullable<ProfilePack["workflowActions"]>;

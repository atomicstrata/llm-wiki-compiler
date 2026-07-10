/**
 * @file src/profile/templates/builtin/newsroom.ts
 * @description Builtin install-time package for the newsroom profile template.
 */
import type { ProfilePack } from "../../types.js";
import type { ProfileTemplatePackage } from "../types.js";

export const newsroomEntities = {
  articles: {
    directory: "wiki/articles",
    fields: {
      headline: { type: "string", required: true },
      stage: { type: "enum", enum: ["draft", "edited", "published"], required: true },
    },
    lifecycle: {
      field: "stage", initial: "draft", terminal: ["published"],
      transitions: { draft: ["edited"], edited: ["published"] },
    },
  },
  desks: {
    directory: "wiki/desks",
    fields: {
      name: { type: "string", required: true },
      stage: { type: "enum", enum: ["active", "archived"], required: true },
    },
    lifecycle: {
      field: "stage", initial: "active", terminal: ["archived"],
      transitions: { active: ["archived"] },
    },
  },
  bylines: {
    directory: "wiki/bylines",
    fields: {
      reporter: { type: "string", required: true },
      stage: { type: "enum", enum: ["pending", "confirmed"], required: true },
    },
    lifecycle: {
      field: "stage", initial: "pending", terminal: ["confirmed"],
      transitions: { pending: ["confirmed"] },
    },
  },
} satisfies ProfilePack["entities"];

export const newsroomRelations = {
  "filed-under": { from: ["articles"], to: ["desks"], direction: "directed" },
} satisfies NonNullable<ProfilePack["relations"]>;

export const newsroomWorkflows = {
  "story-pipeline": {
    stages: [
      { id: "draft-article", reads: ["articles"], writes: ["articles"] },
      { id: "file-under-desk", reads: ["articles", "desks"], writes: ["articles", "desks"], gate: "agent:edited" },
    ],
  },
} satisfies NonNullable<ProfilePack["workflows"]>;

export const newsroomWorkflowActions = {
  "story.file": {
    label: "File an article",
    workflow: "story-pipeline",
    operation: "submit",
    trustGate: "trust:desk",
    inputSchema: {
      runId: { type: "string", required: true },
      entityType: { type: "string", required: true },
      slug: { type: "string", required: true },
      body: { type: "string", required: true },
    },
    permissions: { cli: "trusted-write", sdk: "trusted-write", mcp: "staged-write", viewer: "disabled" },
  },
} satisfies NonNullable<ProfilePack["workflowActions"]>;

const profile: ProfilePack = {
  schemaVersion: 1,
  profileId: "newsroom",
  profileVersion: "0.1.0",
  displayName: "Newsroom",
  entities: newsroomEntities,
  relations: newsroomRelations,
  workflows: newsroomWorkflows,
  workflowActions: newsroomWorkflowActions,
};

/** Builtin install package for newsroom projects. */
export const NEWSROOM_TEMPLATE: ProfileTemplatePackage = {
  schemaVersion: 1,
  templateId: "newsroom",
  version: "0.1.0",
  displayName: "Newsroom",
  publisher: "atomicstrata",
  sourceType: "builtin",
  license: "MIT",
  minLlmwikiVersion: "1.0.0",
  description: "Newsroom profile with articles, desks, bylines, a filing relation, and a story pipeline workflow.",
  profile,
};

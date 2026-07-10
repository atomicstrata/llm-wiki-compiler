/**
 * @file test/profile-workflow-actions-validate.test.ts
 * @description Tests for the optional declarative `workflowActions` block on a
 * profile pack (Phase 5) and its fail-closed load validation.
 *
 * A workflow action is a declarative shortcut that resolves to a workflow
 * operation: it names the declared `workflow` it operates on, an `operation`,
 * an optional `inputSchema`, a per-surface REQUESTED `permissions` map, and
 * optional `gate`/`trustGate` strings. These tests pin: a valid block passes
 * `validateProfileShape`; the action id must be a slug-safe DOTTED id and must
 * not collide with a reserved core CLI verb (full id or first segment); the
 * referenced `workflow` must be declared; `gate`/`trustGate` strings must be
 * well-formed; a `gate`-operation action must declare a `gate`; any write/advance
 * operation must declare a gate or trustGate; entityRef `entityTypes` must be
 * declared; and an action-less profile still validates (omitted-for-default).
 */

import { describe, it, expect } from "vitest";
import { validateProfileShape, ProfileValidationError } from "../src/profile/validate.js";
import type { ProfilePack, WorkflowActionDef, ActionInputField } from "../src/profile/types.js";

/** A permissions map naming all four surfaces (the schema requires every one). */
const READ_ONLY_PERMISSIONS = {
  cli: "read-only",
  sdk: "read-only",
  mcp: "read-only",
  viewer: "read-only",
} as const;

/** A minimal valid `gate`-operation action satisfying a human gate. */
/** The `runId` input every runId-bearing action (gate/cancel/…/submit) must declare. */
const REQUIRED_RUN_ID = { type: "string", required: true } as const;

function gateAction(): WorkflowActionDef {
  return {
    label: "Approve review",
    workflow: "idea-to-experiment",
    operation: "gate",
    permissions: { ...READ_ONLY_PERMISSIONS },
    gate: "human:reviewer",
    inputSchema: { runId: { ...REQUIRED_RUN_ID } },
  };
}

/** A `start` action (mints a fresh run, so it needs NO runId input). */
function startAction(): WorkflowActionDef {
  return {
    label: "Start",
    workflow: "idea-to-experiment",
    operation: "start",
    permissions: { ...READ_ONLY_PERMISSIONS },
    trustGate: "trust:author",
  };
}

/** A minimal valid profile with two entities, one workflow, one action. */
function actionProfile(action?: WorkflowActionDef): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research",
    entities: {
      ideas: { directory: "wiki/ideas" },
      experiments: { directory: "wiki/experiments" },
    },
    workflows: {
      "idea-to-experiment": {
        stages: [{ id: "draft", reads: ["ideas"], writes: ["ideas"] }],
      },
    },
    workflowActions: { "research.literature-review": action ?? gateAction() },
  };
}

/** Replace the single action under a chosen id (default id is reused otherwise). */
function withActionId(id: string, action: WorkflowActionDef): ProfilePack {
  const raw = actionProfile(action);
  raw.workflowActions = { [id]: action };
  return raw;
}

describe("validateProfileShape — workflowActions (happy path)", () => {
  it("accepts a valid gate-operation action referencing a declared workflow", () => {
    const result = validateProfileShape(actionProfile());
    expect(result.profile.workflowActions?.["research.literature-review"].operation).toBe("gate");
  });

  it("accepts a cancel action gated by a trustGate", () => {
    const action: WorkflowActionDef = {
      label: "Cancel",
      workflow: "idea-to-experiment",
      operation: "cancel",
      permissions: { ...READ_ONLY_PERMISSIONS },
      trustGate: "trust:author",
      inputSchema: { runId: { ...REQUIRED_RUN_ID } },
    };
    expect(() => validateProfileShape(actionProfile(action))).not.toThrow();
  });

  it("accepts an entityRef input plus a type-matching default on a string field", () => {
    const action = gateAction();
    action.inputSchema = {
      runId: { ...REQUIRED_RUN_ID },
      target: { type: "entityRef", entityTypes: ["ideas"], default: "ideas/x" },
      title: { type: "string", default: "untitled" },
    };
    expect(() => validateProfileShape(actionProfile(action))).not.toThrow();
  });

  it("accepts a status action with neither gate nor trustGate", () => {
    const action: WorkflowActionDef = {
      label: "Status",
      workflow: "idea-to-experiment",
      operation: "status",
      permissions: { ...READ_ONLY_PERMISSIONS },
    };
    expect(() => validateProfileShape(actionProfile(action))).not.toThrow();
  });

  it("accepts a start action gated by a trustGate", () => {
    expect(() => validateProfileShape(actionProfile(startAction()))).not.toThrow();
  });

  it("accepts an entityRef input field pointing at a declared entity type", () => {
    const action = gateAction();
    action.inputSchema = { runId: { ...REQUIRED_RUN_ID }, target: { type: "entityRef", entityTypes: ["ideas"] } };
    expect(() => validateProfileShape(actionProfile(action))).not.toThrow();
  });

  it("accepts a profile with NO workflowActions key (omitted-for-default)", () => {
    const raw = actionProfile();
    delete raw.workflowActions;
    expect(() => validateProfileShape(raw)).not.toThrow();
  });
});

describe("validateProfileShape — workflowActions (fail closed)", () => {
  it("rejects a non-dotted action id", () => {
    const raw = withActionId("research", gateAction());
    expect(() => validateProfileShape(raw)).toThrow(/dotted/);
  });

  it("rejects an action id with an empty segment", () => {
    const raw = withActionId("a..b", gateAction());
    expect(() => validateProfileShape(raw)).toThrow(ProfileValidationError);
  });

  it("rejects an action id whose segment is not slug-safe", () => {
    const raw = withActionId("Research.x", gateAction());
    expect(() => validateProfileShape(raw)).toThrow(/slug-safe/);
  });

  it("rejects a full action id equal to a reserved core verb", () => {
    const raw = withActionId("compile.export", gateAction());
    expect(() => validateProfileShape(raw)).toThrow(/reserved/);
  });

  it("rejects an action id whose FIRST segment is a reserved core verb", () => {
    const raw = withActionId("compile.thing", gateAction());
    expect(() => validateProfileShape(raw)).toThrow(/reserved/);
  });

  it("rejects an action referencing an undeclared workflow", () => {
    const action = gateAction();
    action.workflow = "ghost-flow";
    expect(() => validateProfileShape(actionProfile(action))).toThrow(/not a declared workflow/);
  });

  it("rejects a workflowActions block when the profile declares no workflows", () => {
    const raw = actionProfile();
    delete raw.workflows;
    expect(() => validateProfileShape(raw)).toThrow(/not a declared workflow/);
  });

  it("rejects a gate using a trust kind for the gate field", () => {
    const action = gateAction();
    action.gate = "trust:author";
    expect(() => validateProfileShape(actionProfile(action))).toThrow(/gate/);
  });

  it("rejects a gate id that is not slug-safe (same grammar as stage gates)", () => {
    const action = gateAction();
    action.gate = "human:Foo Bar";
    expect(() => validateProfileShape(actionProfile(action))).toThrow(/gate/);
  });

  it("rejects a trustGate id that is not slug-safe", () => {
    const action: WorkflowActionDef = {
      label: "Start",
      workflow: "idea-to-experiment",
      operation: "start",
      permissions: { ...READ_ONLY_PERMISSIONS },
      trustGate: "trust:UPPER",
    };
    expect(() => validateProfileShape(actionProfile(action))).toThrow(/trustGate/);
  });

  it("rejects a permissions map missing the viewer surface", () => {
    const action = gateAction();
    delete (action.permissions as Partial<typeof action.permissions>).viewer;
    expect(() => validateProfileShape(actionProfile(action))).toThrow(ProfileValidationError);
  });

  it("rejects a malformed trustGate that is not a trust kind", () => {
    const action: WorkflowActionDef = {
      label: "Start",
      workflow: "idea-to-experiment",
      operation: "start",
      permissions: { ...READ_ONLY_PERMISSIONS },
      trustGate: "human:reviewer",
    };
    expect(() => validateProfileShape(actionProfile(action))).toThrow(/trustGate/);
  });

  it("rejects a gate-operation action with no gate", () => {
    const action: WorkflowActionDef = {
      label: "Approve",
      workflow: "idea-to-experiment",
      operation: "gate",
      permissions: { ...READ_ONLY_PERMISSIONS },
    };
    expect(() => validateProfileShape(actionProfile(action))).toThrow(/gate/);
  });

  it("rejects a start action with neither gate nor trustGate", () => {
    const action: WorkflowActionDef = {
      label: "Start",
      workflow: "idea-to-experiment",
      operation: "start",
      permissions: { ...READ_ONLY_PERMISSIONS },
    };
    expect(() => validateProfileShape(actionProfile(action))).toThrow(/gate or trustGate/);
  });

  it("rejects an entityRef input field naming an undeclared entity type", () => {
    const action = gateAction();
    action.inputSchema = { target: { type: "entityRef", entityTypes: ["ghosts"] } };
    expect(() => validateProfileShape(actionProfile(action))).toThrow(/not a declared entity/);
  });

  it("rejects a cancel action with neither gate nor trustGate", () => {
    const action: WorkflowActionDef = {
      label: "Cancel",
      workflow: "idea-to-experiment",
      operation: "cancel",
      permissions: { ...READ_ONLY_PERMISSIONS },
    };
    expect(() => validateProfileShape(actionProfile(action))).toThrow(/gate or trustGate/);
  });

  it("rejects an entityRef input field with no entityTypes (unscoped ref)", () => {
    const action = gateAction();
    action.inputSchema = { target: { type: "entityRef" } };
    expect(() => validateProfileShape(actionProfile(action))).toThrow(/entityTypes/);
  });

  it("rejects an entityRef input field with an empty entityTypes list", () => {
    const action = gateAction();
    action.inputSchema = { target: { type: "entityRef", entityTypes: [] } };
    expect(() => validateProfileShape(actionProfile(action))).toThrow(/entityTypes/);
  });

  it("rejects entityTypes on a non-entityRef field", () => {
    const action = gateAction();
    action.inputSchema = { title: { type: "string", entityTypes: ["ideas"] } };
    expect(() => validateProfileShape(actionProfile(action))).toThrow(/entityTypes/);
  });

  it("rejects a number field whose default is a string", () => {
    const action = gateAction();
    action.inputSchema = { count: { type: "number", default: "nope" } };
    expect(() => validateProfileShape(actionProfile(action))).toThrow(/default/);
  });

  it("accepts an entityRef default whose entityType is in the field's entityTypes", () => {
    const action = gateAction();
    action.inputSchema = { runId: { ...REQUIRED_RUN_ID }, target: { type: "entityRef", entityTypes: ["ideas"], default: "ideas/foo" } };
    expect(() => validateProfileShape(actionProfile(action))).not.toThrow();
  });

  it("rejects an entityRef default whose entityType is out of the field's entityTypes scope", () => {
    const action = gateAction();
    action.inputSchema = { target: { type: "entityRef", entityTypes: ["ideas"], default: "experiments/foo" } };
    expect(() => validateProfileShape(actionProfile(action))).toThrow(/default/);
  });

  it("rejects an entityRef default whose entityType is undeclared", () => {
    const action = gateAction();
    action.inputSchema = { target: { type: "entityRef", entityTypes: ["ideas"], default: "ghost/foo" } };
    expect(() => validateProfileShape(actionProfile(action))).toThrow(/default/);
  });

  it("rejects an entityRef default that is not a qualified <type>/<slug> id", () => {
    const action = gateAction();
    action.inputSchema = { target: { type: "entityRef", entityTypes: ["ideas"], default: "notqualified" } };
    expect(() => validateProfileShape(actionProfile(action))).toThrow(/default/);
  });
});

/** The page fields a `submit` action's marshaller consumes, plus the run id input. */
const PAGE_SUBMIT_SCHEMA: Record<string, ActionInputField> = {
  runId: { type: "string", required: true },
  entityType: { type: "string", required: true },
  slug: { type: "string", required: true },
  body: { type: "string", required: true },
};

/** A `submit` action over the declared workflow, carrying `inputSchema`. */
function submitAction(inputSchema: Record<string, ActionInputField>): WorkflowActionDef {
  return {
    label: "Submit page",
    workflow: "idea-to-experiment",
    operation: "submit",
    permissions: { ...READ_ONLY_PERMISSIONS },
    trustGate: "trust:writer",
    inputSchema,
  };
}

/** The artifact fields a `submit` action's marshaller consumes, plus the run id input. */
const ARTIFACT_SUBMIT_SCHEMA: Record<string, ActionInputField> = {
  runId: { type: "string", required: true },
  artifactType: { type: "string", required: true },
  slug: { type: "string", required: true },
  body: { type: "string", required: true },
};

describe("validateProfileShape — submit actions are PAGE- or ARTIFACT-shaped (M6e scope)", () => {
  it("accepts a page-shaped submit action (entityType/slug/body)", () => {
    expect(() => validateProfileShape(actionProfile(submitAction({ ...PAGE_SUBMIT_SCHEMA })))).not.toThrow();
  });

  it("accepts an artifact-shaped submit action (artifactType/slug/body)", () => {
    expect(() => validateProfileShape(actionProfile(submitAction({ ...ARTIFACT_SUBMIT_SCHEMA })))).not.toThrow();
  });

  it("rejects a submit action declaring a relation 'input' (object payload not expressible)", () => {
    const schema = { ...PAGE_SUBMIT_SCHEMA, input: { type: "string" } } as Record<string, ActionInputField>;
    expect(() => validateProfileShape(actionProfile(submitAction(schema)))).toThrow(/page or artifact outputs only/);
  });

  it("rejects a submit action declaring a lifecycle 'toState'", () => {
    const schema = { ...PAGE_SUBMIT_SCHEMA, toState: { type: "string" } } as Record<string, ActionInputField>;
    expect(() => validateProfileShape(actionProfile(submitAction(schema)))).toThrow(/page or artifact outputs only/);
  });

  it("rejects a submit action carrying a 'kind' discriminator (page/artifact is inferred)", () => {
    const schema = { ...PAGE_SUBMIT_SCHEMA, kind: { type: "string" } } as Record<string, ActionInputField>;
    expect(() => validateProfileShape(actionProfile(submitAction(schema)))).toThrow(/page or artifact outputs only/);
  });

  it("rejects a page-shaped submit action missing a required field (body)", () => {
    const { body: _omit, ...partial } = PAGE_SUBMIT_SCHEMA;
    expect(() => validateProfileShape(actionProfile(submitAction(partial)))).toThrow(/missing the required page input 'body'/);
  });

  it("rejects an artifact-shaped submit action missing a required field (slug)", () => {
    const { slug: _omit, ...partial } = ARTIFACT_SUBMIT_SCHEMA;
    expect(() => validateProfileShape(actionProfile(submitAction(partial)))).toThrow(/missing the required artifact input 'slug'/);
  });

  it("rejects a submit action declaring BOTH artifactType and entityType (page or artifact, not both)", () => {
    const schema = { ...PAGE_SUBMIT_SCHEMA, artifactType: { type: "string", required: true } } as Record<string, ActionInputField>;
    expect(() => validateProfileShape(actionProfile(submitAction(schema)))).toThrow(/entityType and artifactType/);
  });
});

describe("validateProfileShape — runId-bearing actions must declare runId (or they are dead)", () => {
  const RUNID_OPS = ["resume", "advance", "gate", "cancel", "fail", "submit"] as const;

  for (const operation of RUNID_OPS) {
    it(`rejects a '${operation}' action that omits the runId input (can never be invoked)`, () => {
      const action = { ...gateAction(), operation, inputSchema: {} } as WorkflowActionDef;
      if (operation === "submit") action.inputSchema = { entityType: { type: "string", required: true }, slug: { type: "string", required: true }, body: { type: "string", required: true } };
      expect(() => validateProfileShape(actionProfile(action))).toThrow(/requires a 'runId' input/);
    });
  }

  it("rejects a runId input that is not required (a non-required runId is an incomplete contract)", () => {
    const action = { ...gateAction(), inputSchema: { runId: { type: "string" } } } as WorkflowActionDef;
    expect(() => validateProfileShape(actionProfile(action))).toThrow(/must be a required 'string'/);
  });

  it("rejects a runId input carrying a default (defaults defeat the per-invocation target)", () => {
    const action = { ...gateAction(), inputSchema: { runId: { type: "string", required: true, default: "build-2026-01-01-abcd" } } } as WorkflowActionDef;
    expect(() => validateProfileShape(actionProfile(action))).toThrow(/no default|per-invocation/);
  });

  it("does NOT require runId on a 'start' action (it mints a fresh run)", () => {
    expect(() => validateProfileShape(actionProfile(startAction()))).not.toThrow();
  });
});

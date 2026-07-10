/**
 * @file test/workflow-local-config.test.ts
 * @description Tests for the confined local-grant reader (`.llmwiki/config.json`).
 *
 * The CRITICAL invariant: a hostile/corrupt local config can NEVER yield more
 * than `read-only`. An ABSENT config defaults to the surface cap (no extra local
 * restriction). A valid config can TIGHTEN. Confinement mirrors the run store:
 * a symlinked/oversize/non-regular leaf, or an escaping `.llmwiki`, fails closed
 * to `read-only` and never returns out-of-tree bytes.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadLocalGrant, localEnablesHumanGate } from "../src/workflows/local-config.js";
import { effectivePermission, SURFACE_HARD_CAP } from "../src/workflows/authority.js";
import { LLMWIKI_DIR, MAX_LOCAL_CONFIG_BYTES } from "../src/utils/constants.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";

const ctx = useConfinementRoots("wf-local-config");

/** Path to the project's `.llmwiki/config.json` leaf. */
function configLeaf(root: string): string {
  return path.join(root, LLMWIKI_DIR, "config.json");
}

/** Write a `.llmwiki/config.json` with the given JSON body. */
async function writeConfig(root: string, body: string): Promise<void> {
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  await writeFile(configLeaf(root), body, "utf8");
}

describe("loadLocalGrant absent/default behavior", () => {
  it("returns the surface cap when no config exists", async () => {
    expect(await loadLocalGrant(ctx.root, "cli")).toBe("trusted-write");
    expect(await loadLocalGrant(ctx.root, "mcp")).toBe("staged-write");
  });

  it("returns the surface cap when the surface key is absent from a present config", async () => {
    await writeConfig(ctx.root, JSON.stringify({ version: 1, workflowGrants: {} }));
    expect(await loadLocalGrant(ctx.root, "cli")).toBe("trusted-write");
  });
});

describe("loadLocalGrant tightening", () => {
  it("honors a valid tightening grant", async () => {
    await writeConfig(ctx.root, JSON.stringify({ workflowGrants: { cli: "read-only" } }));
    expect(await loadLocalGrant(ctx.root, "cli")).toBe("read-only");
  });

  it("returns a high grant verbatim, which effectivePermission then clamps to the surface cap", async () => {
    // Local config returning a high value is fine: its ONLY role is to tighten,
    // and effectivePermission mins it with the surface cap.
    await writeConfig(ctx.root, JSON.stringify({ workflowGrants: { mcp: "trusted-write" } }));
    const grant = await loadLocalGrant(ctx.root, "mcp");
    expect(grant).toBe("trusted-write");
    expect(effectivePermission("trusted-write", grant, "mcp")).toBe(SURFACE_HARD_CAP.mcp);
  });
});

describe("loadLocalGrant fails closed to read-only", () => {
  it("fails closed on corrupt JSON", async () => {
    await writeConfig(ctx.root, "{ not json");
    expect(await loadLocalGrant(ctx.root, "cli")).toBe("read-only");
  });

  it("fails closed on a non-CapabilityClass grant value", async () => {
    await writeConfig(ctx.root, JSON.stringify({ workflowGrants: { cli: "god-mode" } }));
    expect(await loadLocalGrant(ctx.root, "cli")).toBe("read-only");
  });

  it("fails closed on an oversize config", async () => {
    const pad = "x".repeat(MAX_LOCAL_CONFIG_BYTES + 1);
    await writeConfig(ctx.root, JSON.stringify({ workflowGrants: { cli: "trusted-write" }, pad }));
    expect(await loadLocalGrant(ctx.root, "cli")).toBe("read-only");
  });
});

describe("loadLocalGrant symlink confinement", () => {
  it("never reads out-of-tree bytes through a symlinked config leaf", async () => {
    await mkdir(path.join(ctx.root, LLMWIKI_DIR), { recursive: true });
    const victim = path.join(ctx.outside, "victim.json");
    await writeFile(victim, JSON.stringify({ workflowGrants: { cli: "trusted-write" } }), "utf8");
    let created = true;
    try { await symlink(victim, configLeaf(ctx.root)); } catch { created = false; }
    if (!created) return; // skip: platform cannot create symlinks
    expect(await loadLocalGrant(ctx.root, "cli")).toBe("read-only");
  });

  it("fails closed to read-only when .llmwiki escapes the root", async () => {
    let created = true;
    try { await symlink(ctx.outside, path.join(ctx.root, LLMWIKI_DIR), "dir"); } catch { created = false; }
    if (!created) return; // skip: platform cannot create symlinks
    expect(await loadLocalGrant(ctx.root, "cli")).toBe("read-only");
  });
});

describe("localEnablesHumanGate — out-of-workspace anchor (C2)", () => {
  const ENV = "LLMWIKI_ENABLED_HUMAN_GATES";

  afterEach(() => {
    delete process.env[ENV];
  });

  it("is true when LLMWIKI_ENABLED_HUMAN_GATES lists the gate (operator-set, out of workspace)", async () => {
    process.env[ENV] = "human:approve";
    expect(await localEnablesHumanGate(ctx.root, "human:approve")).toBe(true);
  });

  it("parses a comma/space-separated list and matches a member", async () => {
    process.env[ENV] = "human:approve, human:lead-review agent:check";
    expect(await localEnablesHumanGate(ctx.root, "human:lead-review")).toBe(true);
    expect(await localEnablesHumanGate(ctx.root, "agent:check")).toBe(true);
    expect(await localEnablesHumanGate(ctx.root, "human:other")).toBe(false);
  });

  it("is false when the env var is unset", async () => {
    expect(await localEnablesHumanGate(ctx.root, "human:lead-review")).toBe(false);
  });

  it("IGNORES enabledHumanGates in the workspace config (the C2 self-grant exploit is dead)", async () => {
    // The agent can write .llmwiki/config.json, so it can NEVER be the enablement
    // anchor. Even when the workspace config lists the gate, enablement requires
    // the operator-set env var (which the agent cannot reach).
    await writeConfig(ctx.root, JSON.stringify({ enabledHumanGates: ["human:approve"] }));
    expect(await localEnablesHumanGate(ctx.root, "human:approve")).toBe(false);
  });
});

/**
 * @file test/agent-discovery.test.ts
 * @description Acceptance checks for the agent discovery surfaces that ship
 * with the package: the MCP Registry manifest, the bundled Agent Skill, the
 * npm metadata that registries and agents search, and the MCP server's
 * self-description. Each check pins a contract an external consumer relies on
 * (registry schema, Agent Skills spec, npm `files`), so a release cannot
 * silently drift into an entry that publishes but cannot be found or run.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import yaml from "js-yaml";
import { describe, expect, it, afterEach } from "bun:test";
import { connectMcpClient, useMcpRoot, type McpClientHandle } from "./fixtures/mcp-test-env.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SKILL_DIR = path.join(REPO_ROOT, "skills", "llmwiki");
const REGISTRY_SCHEMA = path.join(REPO_ROOT, "test/fixtures/mcp-registry/server.schema.2025-12-11.json");
const AGENT_SKILLS_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_NAME_CHARS = 64;
const MAX_SKILL_DESCRIPTION_CHARS = 1024;
const MAX_SKILL_COMPATIBILITY_CHARS = 500;
const MAX_SKILL_BODY_LINES = 500;
const MAX_REGISTRY_DESCRIPTION_CHARS = 100;

interface PackageManifest {
  name: string; version: string; description: string; mcpName: string;
  keywords: string[]; files: string[]; bin: Record<string, string>;
}
interface RegistryArgument { type: string; name?: string; value?: string; isRequired?: boolean; format?: string }
interface RegistryManifest {
  name: string; description: string; version: string; websiteUrl: string; repository: { url: string };
  packages: Array<{ registryType: string; identifier: string; version: string; runtimeHint?: string;
    transport: { type: string }; packageArguments: RegistryArgument[] }>;
}
interface SkillFrontmatter { name: string; description: string; compatibility?: string; license?: string }

/** Read the release manifest used by npm and the registry generator. */
function readPackageManifest(): PackageManifest {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as PackageManifest;
}

/** Exercise the generator as a consumer would, through its command output. */
function generateRegistryManifest(): RegistryManifest {
  const stdout = execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts/mcp-manifest.mjs")], { encoding: "utf8" });
  return JSON.parse(stdout) as RegistryManifest;
}

/** Assert every name appears in `text`, in the given order (first occurrence). */
function expectMentionedInOrder(text: string, names: string[]): void {
  const positions = names.map((name) => text.indexOf(name));
  expect(positions.every((index) => index >= 0), `missing one of ${names.join(", ")}`).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
}

/** Split the shipped skill into its discovery metadata and agent instructions. */
function readSkill(): { frontmatter: SkillFrontmatter; body: string } {
  const text = readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error("SKILL.md must start with YAML frontmatter");
  return { frontmatter: yaml.load(match[1]) as SkillFrontmatter, body: match[2] };
}

describe("MCP Registry manifest", () => {
  it("validates against the pinned registry server schema", () => {
    // Formats are checked by hand below so the test needs no extra format plugin.
    const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    const validate = ajv.compile(JSON.parse(readFileSync(REGISTRY_SCHEMA, "utf8")));
    const manifest = generateRegistryManifest();
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(manifest.description.length).toBeLessThanOrEqual(MAX_REGISTRY_DESCRIPTION_CHARS);
    expect(new URL(manifest.websiteUrl).protocol).toBe("https:");
    expect(new URL(manifest.repository.url).hostname).toBe("github.com");
  });

  it("binds the entry to the exact npm package, version, and mcpName", () => {
    const pkg = readPackageManifest();
    const manifest = generateRegistryManifest();
    expect(manifest.name).toBe(pkg.mcpName);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.packages).toHaveLength(1);
    expect(manifest.packages[0]).toMatchObject({
      registryType: "npm", identifier: pkg.name, version: pkg.version, runtimeHint: "npx", transport: { type: "stdio" },
    });
  });

  it("launches the server with an explicit project root", () => {
    const [serve, root, ...rest] = generateRegistryManifest().packages[0].packageArguments;
    expect(rest).toEqual([]);
    expect(serve).toEqual({ type: "positional", value: "serve" });
    expect(root).toMatchObject({ type: "named", name: "--root", isRequired: true, format: "filepath" });
    // valueHint belongs to positional arguments only; the schema is permissive, so pin it here.
    expect(root).not.toHaveProperty("valueHint");
  });
});

describe("bundled Agent Skill", () => {
  it("has frontmatter that satisfies the Agent Skills specification", () => {
    const { frontmatter } = readSkill();
    expect(frontmatter.name).toBe(path.basename(SKILL_DIR));
    expect(frontmatter.name).toMatch(AGENT_SKILLS_NAME);
    expect(frontmatter.name.length).toBeLessThanOrEqual(MAX_SKILL_NAME_CHARS);
    expect(frontmatter.description.length).toBeGreaterThan(0);
    expect(frontmatter.description.length).toBeLessThanOrEqual(MAX_SKILL_DESCRIPTION_CHARS);
    expect(frontmatter.compatibility?.length ?? 0).toBeLessThanOrEqual(MAX_SKILL_COMPATIBILITY_CHARS);
  });

  it("describes when to use and when not to use the skill", () => {
    const { frontmatter, body } = readSkill();
    expect(frontmatter.description).toMatch(/Use for/);
    expect(frontmatter.description).toMatch(/does not need a wiki/);
    expect(body.split("\n").length).toBeLessThanOrEqual(MAX_SKILL_BODY_LINES);
  });

  it("routes connected agents to inspection and evidence before generation", () => {
    expectMentionedInOrder(readSkill().body, ["wiki_status", "get_context_pack", "query_wiki", "ingest_source", "compile_wiki"]);
  });

  it("only links to the published documentation site or the repository", () => {
    const links = [...readSkill().body.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toMatch(/^https:\/\/(llmwiki\.atomicstrata\.ai|github\.com\/atomicstrata)\//);
    }
  });

  it("ships inside the npm tarball", () => {
    expect(readPackageManifest().files).toContain("skills/llmwiki/");
    const report = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: REPO_ROOT, encoding: "utf8" });
    const packed = (JSON.parse(report) as Array<{ files: Array<{ path: string }> }>)[0].files.map((f) => f.path);
    expect(packed).toContain("skills/llmwiki/SKILL.md");
  });
});

describe("npm discovery metadata", () => {
  it("names the MCP server and the agent-facing keywords registries search", () => {
    const pkg = readPackageManifest();
    expect(pkg.mcpName).toMatch(/^io\.github\.atomicstrata\/[a-z0-9-]+$/);
    expect(pkg.bin).toHaveProperty("llmwiki");
    expect(pkg.keywords).toEqual(expect.arrayContaining(["mcp", "mcp-server", "ai-agents", "agent-skills", "knowledge-base"]));
    expect(pkg.description).toMatch(/MCP server/);
  });
});

describe("MCP server self-description", () => {
  const root = useMcpRoot("llmwiki-discovery-");
  let handle: McpClientHandle | undefined;
  afterEach(async () => { await handle?.client.close(); handle = undefined; });

  it("tells a connected agent to inspect and retrieve before writing", async () => {
    handle = await connectMcpClient(root.value);
    expectMentionedInOrder(handle.client.getInstructions() ?? "", ["wiki_status", "get_context_pack", "ingest_source", "compile_wiki"]);
  });

  it("labels every mutating or provider-backed tool in its description", async () => {
    handle = await connectMcpClient(root.value);
    const tools = new Map((await handle.client.listTools()).tools.map((t) => [t.name, t.description ?? ""]));
    expect(tools.get("ingest_source")).toMatch(/Writes project files/);
    expect(tools.get("compile_wiki")).toMatch(/Writes wiki/);
    expect(tools.get("compile_wiki")).toMatch(/Requires an LLM provider/);
    expect(tools.get("search_pages")).toMatch(/Requires an LLM provider/);
    expect(tools.get("query_wiki")).toMatch(/use get_context_pack instead/);
    expect(tools.get("get_context_pack")).toMatch(/Read-only/);
    expect(tools.get("wiki_status")).toMatch(/No provider credentials required/);
  });
});

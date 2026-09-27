/**
 * Protocol-level tests for MCP page reads: the `wiki-concept` / `wiki-query`
 * resource templates and the `read_page` tool.
 *
 * Every case goes through a real SDK Client connected over the in-memory
 * transport, so request URIs pass through the SDK's own URI normalisation and
 * template matching. That is what decides which `{slug}` value the read callback
 * receives, and it is the step a direct callback call would skip.
 *
 * Resource slugs are percent-decoded, so `%2F` becomes a path separator. These
 * tests pin that a decoded or tool-supplied slug can only name a page directly
 * inside its own directory, while Unicode, space, `#` and `%` slugs still read.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, symlink, writeFile } from "fs/promises";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writePage } from "./fixtures/write-page.js";
import { buildServer, useMcpRoot } from "./fixtures/mcp-test-env.js";

/** Body planted in every file a traversal must not be able to read. */
const SECRET_BODY = "SECRET-BYTES";

const rootHandle = useMcpRoot("llmwiki-mcp-confine");
let root: string;
let client: Client;

beforeEach(async () => {
  root = rootHandle.value;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildServer(root).connect(serverTransport);
  client = new Client({ name: "confinement-test", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
});

/** Read a resource over the protocol and parse its JSON page payload. */
async function readResource(uri: string): Promise<{ slug: string; body: string }> {
  const result = await client.readResource({ uri });
  const [content] = result.contents;
  if (!("text" in content)) throw new Error(`expected a text resource for ${uri}`);
  return JSON.parse(content.text);
}

/** Plant `secret.md` in the project root and in its parent directory. */
async function plantSecrets(): Promise<void> {
  const secret = `---\ntitle: Secret\n---\n${SECRET_BODY}\n`;
  await writeFile(path.join(root, "secret.md"), secret);
  await writeFile(path.join(root, "wiki", "secret.md"), secret);
}

describe("MCP page resources: encoded traversal", () => {
  it("refuses a concept slug whose %2F segments climb out of wiki/concepts", async () => {
    await plantSecrets();
    for (const slug of ["..%2Fsecret", "..%2F..%2Fsecret", "..%5C..%5Csecret"]) {
      await expect(readResource(`llmwiki://concept/${slug}`)).rejects.toThrow(/Page not found/);
    }
  });

  it("refuses the same traversal through the query resource", async () => {
    await plantSecrets();
    await expect(readResource("llmwiki://query/..%2F..%2Fsecret")).rejects.toThrow(/Page not found/);
  });

  it("does not follow a page symlinked outside its directory", async () => {
    await plantSecrets();
    await symlink(path.join(root, "secret.md"), path.join(root, "wiki/concepts/linked.md"));
    await expect(readResource("llmwiki://concept/linked")).rejects.toThrow(/Page not found/);
  });

  it("refuses a slug naming a file in a subdirectory of wiki/concepts", async () => {
    await mkdir(path.join(root, "wiki/concepts/nested"), { recursive: true });
    await writePage(path.join(root, "wiki/concepts/nested"), "inner", { title: "Inner", summary: "S" }, SECRET_BODY);
    await expect(readResource("llmwiki://concept/nested%2Finner")).rejects.toThrow(/Page not found/);
  });

  it("still reads a page one directory component names", async () => {
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha", summary: "S" }, "Alpha body.");
    await expect(readResource("llmwiki://concept/alpha")).resolves.toMatchObject({ slug: "alpha", body: "Alpha body." });
  });
});

/** Slugs that must keep reading through their percent-encoded URI. */
const LEGITIMATE_SLUGS = ["ai理赔审核覆盖率与目标", "Foo #1", "50% off"];

describe("MCP page resources: legitimate slugs", () => {
  it("reads Unicode, space-and-hash and literal-percent slugs from encoded URIs", async () => {
    for (const slug of LEGITIMATE_SLUGS) {
      await writePage(path.join(root, "wiki/concepts"), slug, { title: slug, summary: "S" }, `Body of ${slug}.`);
      const parsed = await readResource(`llmwiki://concept/${encodeURIComponent(slug)}`);
      expect(parsed).toMatchObject({ slug, body: `Body of ${slug}.` });
    }
  });

  it("falls back to the raw slug when a bare percent sign is not valid escaping", async () => {
    const slug = "100%";
    await writePage(path.join(root, "wiki/concepts"), slug, { title: "Full", summary: "S" }, "Full body.");
    const parsed = await readResource("llmwiki://concept/100%");
    expect(parsed).toMatchObject({ slug, body: "Full body." });
  });
});

describe("read_page tool confinement", () => {
  it("refuses a slug that climbs out of the page directories", async () => {
    await plantSecrets();
    await mkdir(path.join(root, "wiki/queries"), { recursive: true });
    for (const slug of ["../secret", "../../secret", "..\\..\\secret"]) {
      const result = await client.callTool({ name: "read_page", arguments: { slug } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).not.toContain(SECRET_BODY);
    }
  });

  it("does not follow a page symlinked outside its directory", async () => {
    await plantSecrets();
    await symlink(path.join(root, "secret.md"), path.join(root, "wiki/concepts/linked.md"));
    const result = await client.callTool({ name: "read_page", arguments: { slug: "linked" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).not.toContain(SECRET_BODY);
  });
});

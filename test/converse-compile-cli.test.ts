/**
 * Exercise real compile and refresh commands over the Converse wire protocol.
 * Only the external model service is simulated; prompts, extraction, rendering,
 * source tracking, and persisted provenance use the production compiler.
 */
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { expectCLIExit, runCLI } from "./fixtures/run-cli.js";
import { closeLoopback, listenLoopback } from "./fixtures/loopback-http.js";

let server: Server;
let workspace: string;
let endpoint: string;
let requests: string[];

beforeEach(async () => {
  requests = [];
  workspace = await mkdtemp(path.join(tmpdir(), "llmwiki-converse-cli-"));
  await mkdir(path.join(workspace, "sources"));
  await writeFile(path.join(workspace, "sources/intro.md"), "# Documented Topic\n\nWidgets are blue.\n");
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(request.url ?? "");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(cannedResponse(Boolean(body.toolConfig))));
  });
  endpoint = `${await listenLoopback(server)}/proxy/test-route`;
});

afterEach(async () => {
  await closeLoopback(server);
  await rm(workspace, { recursive: true, force: true });
});

it("compiles and refreshes cited pages through the explicit Converse route", async () => {
  const env = { LLMWIKI_PROVIDER: "converse", LLMWIKI_MODEL: "test-model:1",
    LLMWIKI_CONVERSE_BASE_URL: endpoint, LLMWIKI_CONVERSE_API_KEY: "synthetic-secret", LLMWIKI_EMBEDDINGS: "off" };
  expectCLIExit(await runCLI(["compile"], workspace, env), 0);
  const pagePath = path.join(workspace, "wiki/concepts/documented-topic.md");
  const page = await readFile(pagePath, "utf8");
  expect(page).toContain("Widgets are blue");
  expect(page).toContain("^[intro.md");
  expect(page).toContain("test-model:1");
  const beforeRefresh = requests.length;
  await writeFile(path.join(workspace, "sources/intro.md"), "# Documented Topic\n\nWidgets are blue and inspected.\n");
  expectCLIExit(await runCLI(["refresh", "--stale"], workspace, env), 0);
  expect(requests.length).toBeGreaterThan(beforeRefresh);
  expect(requests.every((url) => url === "/proxy/test-route/model/test-model%3A1/converse")).toBe(true);
  expect(await readFile(pagePath, "utf8")).toContain("Widgets are blue");
});

/** Return source-grounded extraction and page text for the synthetic document. */
function cannedResponse(toolCall: boolean): unknown {
  const content = toolCall ? [{ toolUse: { toolUseId: "extraction-1", name: "extract_concepts", input: { concepts: [{
    concept: "Documented Topic", summary: "Widget color", is_new: true, confidence: 0.95, provenance_state: "extracted",
  }] } } }] : [{ text: "# Documented Topic\n\nWidgets are blue. ^[intro.md:3]\n" }];
  return { output: { message: { role: "assistant", content } }, stopReason: toolCall ? "tool_use" : "end_turn",
    usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 } };
}

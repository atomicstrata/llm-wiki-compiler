/** Opt-in viewer integration keeps source bodies off default and LAN surfaces. */
import { afterEach, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { createDemo } from "./fixtures/source-review-project.js";
import { startViewer } from "../src/viewer/server.js";
import { get } from "node:http";

const roots: string[] = [];
const servers: Awaited<ReturnType<typeof startViewer>>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Only disposable demo roots are exposed; every server is closed by the test. */
async function fixture(sourceChanges?: boolean, host = "127.0.0.1") {
  const root = await createDemo(); roots.push(root);
  const server = await startViewer({ root, host, port: 0, sourceChanges }); servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

it("leaves the default reviews envelope unchanged and the new route disabled", async () => {
  const url = await fixture();
  expect((await fetch(`${url}/api/source-changes`)).status).toBe(404);
  const reviews = await (await fetch(`${url}/api/reviews`)).json();
  expect(Object.keys(reviews).sort()).toEqual(["reviews", "total"]);
});

it("serves the shared observation only after explicit loopback opt-in", async () => {
  const url = await fixture(true);
  const response = await fetch(`${url}/api/source-changes`);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const report = await response.json();
  expect(report.projectRoot).toBe(roots.at(-1));
  expect(report.pages[0].excerpts[0].text).toContain("60 seconds");
  expect(report.pages[0].candidates[0].checks.sources).toBe("matches");
  expect((await (await fetch(`${url}/api/reviews`)).json()).sourceChanges).toBe(true);
});

it("rejects hostile origin and write requests even when enabled", async () => {
  const url = await fixture(true);
  expect((await fetch(`${url}/api/source-changes`, { headers: { Origin: "https://example.com" } })).status).toBe(403);
  expect((await fetch(`${url}/api/source-changes`, { method: "POST" })).status).toBe(404);
});

it("does not activate source comparison on a LAN bind", async () => {
  const url = await fixture(true, "0.0.0.0");
  const headers = { Host: new URL(url).host.replace("127.0.0.1", "0.0.0.0") };
  const response = await requestWithHost(`${url}/api/source-changes`, headers);
  expect(response.status).toBe(404);
  expect((await requestWithHost(`${url}/api/reviews`, headers)).body.sourceChanges).toBeUndefined();
});

/** node:http preserves the exact Host header needed to exercise the LAN gate. */
function requestWithHost(url: string, headers: { Host: string }): Promise<{ status: number | undefined; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    get(url, { headers }, response => {
      let body = "";
      response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      response.on("error", reject);
    }).on("error", reject);
  });
}

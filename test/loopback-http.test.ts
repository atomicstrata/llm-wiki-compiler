/**
 * The loopback HTTP fixture's port contract (`./fixtures/loopback-http.ts`).
 *
 * Malformed or reserved `LLMWIKI_TEST_LOOPBACK_PORT` values are rejected before
 * anything is bound. With a valid configured port (a sandboxed run that may only
 * use that one loopback port sets it), the fixture binds exactly 127.0.0.1 on
 * that port and serves its own response, and a second bind of the occupied port
 * is refused without falling back while the first listener keeps serving.
 * Without the setting the two fixed-port cases are skipped: binding an arbitrary
 * port here would need broader permission than such a run grants. Tests run
 * sequentially; every environment stub is restored and every owned server is
 * closed after each test, including when an assertion fails.
 */
import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "bun:test";
import { closeLoopback, listenLoopback } from "./fixtures/loopback-http.js";
import { restoreEnv, stubEnv } from "./stubs.js";

const PORT_ENV = "LLMWIKI_TEST_LOOPBACK_PORT";
/** The fixed port this run was given, read before any test stubs the variable. */
const CONFIGURED = process.env[PORT_ENV];
const REQUEST_MS = 3000;
const owned: Server[] = [];

afterEach(async () => {
  restoreEnv();
  for (const server of owned.splice(0)) await closeLoopback(server);
});

/** An owned server answering every request with `body`; closed after the test. */
function ownedServer(body: string): Server {
  const server = createServer((request, response) => {
    request.resume();
    response.end(body);
  });
  owned.push(server);
  return server;
}

/** The body the own listener at `url` returns for one request, with a bounded deadline. */
async function bodyAt(url: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_MS) });
  return { status: response.status, text: await response.text() };
}

it.each(["", " 8080", "+8080", "0x1f90", "8080.5", "8e3", "1023", "65536", "1234", "11434"])(
  "rejects the port setting %p before listening",
  async (value) => {
    stubEnv(PORT_ENV, value);
    const server = ownedServer("unused");
    await expect(listenLoopback(server)).rejects.toThrow(PORT_ENV);
    expect(server.listening).toBe(false);
  },
);

it.skipIf(CONFIGURED === undefined)("binds exactly the configured loopback port and serves its own response", async () => {
  const nonce = crypto.randomUUID();
  const url = await listenLoopback(ownedServer(nonce));
  expect(url).toBe(`http://127.0.0.1:${CONFIGURED}`);
  expect(await bodyAt(url)).toEqual({ status: 200, text: nonce });
});

it.skipIf(CONFIGURED === undefined)("refuses an occupied configured port without fallback while the first listener keeps serving", async () => {
  const nonce = crypto.randomUUID();
  const url = await listenLoopback(ownedServer(nonce));
  const second = ownedServer("second");
  await expect(listenLoopback(second)).rejects.toMatchObject({ code: "EADDRINUSE" });
  expect(second.listening).toBe(false);
  expect(await bodyAt(url)).toEqual({ status: 200, text: nonce });
});

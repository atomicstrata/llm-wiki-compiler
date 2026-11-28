/**
 * Loopback HTTP helpers for tests that exercise a real HTTP boundary.
 *
 * The server binds 127.0.0.1 only, so no remote service is contacted, and
 * closing drops kept-alive sockets so teardown never hangs.
 *
 * PORT SELECTION (test-only opt-in). By default the server binds an ephemeral
 * port (0). A sandboxed test run that may only use one exact loopback port can
 * set `LLMWIKI_TEST_LOOPBACK_PORT` to that port: a decimal integer from 1024 to
 * 65535 with no sign, spaces or leading zero, excluding the local model-server
 * ports 1234 and 11434. Any other value is rejected before anything is bound.
 * The bind is exclusive and is never retried or moved to another port: if the
 * port is taken, the returned promise rejects. Before a URL is returned the
 * kernel's address must be exactly IPv4 127.0.0.1 on the configured port (any
 * positive port when unset); otherwise the server is closed and the call throws,
 * so a test can never be handed a URL that reaches some other service.
 */
import type { Server } from "node:http";

const LOOPBACK = "127.0.0.1";
const PORT_ENV = "LLMWIKI_TEST_LOOPBACK_PORT";
/** 1024-65535 as plain decimal digits: no sign, whitespace, leading zero, fraction or exponent. */
const PORT_PATTERN = /^[1-9][0-9]{3,4}$/;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
/** Local model-server ports (LM Studio, Ollama) a test fixture must never occupy. */
const REFUSED_PORTS = new Set([1234, 11434]);

/** The port to bind: 0 (ephemeral) when the opt-in is unset, else the validated configured port. */
function configuredPort(): number {
  const raw = process.env[PORT_ENV];
  if (raw === undefined) return 0;
  const port = PORT_PATTERN.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT || REFUSED_PORTS.has(port)) {
    throw new Error(`${PORT_ENV} must be a decimal port from ${MIN_PORT} to ${MAX_PORT}, not 1234 or 11434`);
  }
  return port;
}

/** Listen once on exactly 127.0.0.1:`port`, rejecting on an emitted or thrown listen error; no retry. */
function bindExactly(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const detach = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error) => { detach(); reject(error); };
    const onListening = () => { detach(); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen({ port, host: LOOPBACK, exclusive: true });
    } catch (error) {
      detach();
      reject(error);
    }
  });
}

/** Start an isolated HTTP service and return its loopback base URL. */
export async function listenLoopback(server: Server): Promise<string> {
  const port = configuredPort();
  await bindExactly(server, port);
  const address = server.address();
  const exact = address !== null && typeof address === "object" && address.family === "IPv4"
    && address.address === LOOPBACK && address.port > 0 && (port === 0 || address.port === port);
  if (!exact) {
    await closeLoopback(server);
    throw new Error(`loopback fixture bound ${JSON.stringify(address)}, not ${LOOPBACK}:${port === 0 ? "<ephemeral>" : port}`);
  }
  return `http://${LOOPBACK}:${address.port}`;
}

/** Close active HTTP sockets before returning from a transport fixture. */
export async function closeLoopback(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

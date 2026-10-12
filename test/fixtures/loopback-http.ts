/**
 * Loopback HTTP helpers for tests that exercise a real HTTP boundary.
 * The server binds an ephemeral port on 127.0.0.1, so no remote service is
 * contacted, and closing drops kept-alive sockets so teardown never hangs.
 */
import type { Server } from "node:http";

/** Start an isolated HTTP service and return its loopback base URL. */
export async function listenLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}

/** Close active HTTP sockets before returning from a transport fixture. */
export async function closeLoopback(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

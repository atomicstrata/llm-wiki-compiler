/**
 * @file test/limited-isolation/net-probe-fixture.ts
 * @description The network half of the limited-isolation witnesses, shared by
 * the backend's own gate and the pack-seam integration witness: whether the
 * platform's isolation tool is present, a loopback listener that COUNTS its
 * connections, and the parent-side reachability check that keeps a "blocked"
 * result non-vacuous. One home, because a drifted copy of the reachability
 * check is a witness that can silently start proving nothing.
 */

import { spawnSync } from "node:child_process";
import net from "node:net";

/** Is the platform's isolation tool available here? */
export function isolationToolPresent(): boolean {
  const tool = process.platform === "darwin" ? "sandbox-exec" : process.platform === "linux" ? "bwrap" : "";
  if (tool === "") return false;
  return spawnSync(tool, ["--help"], { stdio: "ignore" }).error === undefined;
}

/** A loopback listener that COUNTS the connections it receives. */
export interface CountingListenerV1 {
  readonly port: number;
  connections(): number;
  close(): void;
}

/** Start the counting listener the probe (and the non-vacuity check) dials. */
export function countingListener(): Promise<CountingListenerV1> {
  return new Promise((resolve) => {
    let count = 0;
    const server = net.createServer((sock) => { count += 1; sock.end(); });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, connections: () => count, close: () => server.close() });
    });
  });
}

/** True when THIS process can reach the listener — the non-vacuity precondition. */
export function outerCanReach(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (reached: boolean): void => { try { sock.destroy(); } catch { /* closed */ } resolve(reached); };
    sock.setTimeout(3000);
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
    sock.on("timeout", () => done(false));
  });
}

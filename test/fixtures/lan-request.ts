/**
 * Request a viewer bound beyond loopback the way a LAN client would.
 *
 * The viewer accepts only its own bind address as `Host`. `fetch` always sends
 * the address it connected to, so tests of a `0.0.0.0` bind send the request
 * with Node's `http` and set the Host header the server expects.
 */
import http from "http";

/** GET `pathname` from a viewer bound to `0.0.0.0:port`. */
export function lanRequest(port: number, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: pathname, headers: { Host: `0.0.0.0:${port}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    }).on("error", reject);
  });
}

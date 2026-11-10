/**
 * Send a viewer request with exact headers.
 *
 * The viewer decides what to serve from `Host`, `Origin` and the `Sec-Fetch-*`
 * headers. `fetch` sets or forbids several of those, so tests of the origin
 * policy send requests with Node's `http` and name every header themselves.
 */
import http from "http";

/** A response reduced to what origin-policy tests assert on. */
interface ViewerResponse {
  status: number;
  body: string;
}

/** GET `pathname` from the viewer on loopback `port`, sending exactly `headers`. */
export function viewerRequest(port: number, pathname: string, headers: Record<string, string>): Promise<ViewerResponse> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: pathname, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    }).on("error", reject);
  });
}

/** GET `pathname` from a viewer bound to `0.0.0.0:port`, the way a LAN client would. */
export function lanRequest(port: number, pathname: string): Promise<ViewerResponse> {
  return viewerRequest(port, pathname, { Host: `0.0.0.0:${port}` });
}

/**
 * @file src/connectors/private-address.ts
 * @description Non-public IP classification for the connector SSRF policy.
 *
 * Every address a connector hostname resolves to — and every redirect hop —
 * must pass this classifier before the socket dials. IPv6 transition forms that
 * embed an IPv4 address (mapped, NAT64, 6to4, and the deprecated
 * IPv4-compatible ::/96) are decomposed and judged by the embedded IPv4, so a
 * hostile resolver cannot smuggle a private target inside an IPv6 literal.
 */

const HEX = /^[0-9a-fA-F]{1,4}$/;
type Ipv4Range = readonly [number, number, number, number, number, number, number, number];

const NON_PUBLIC_IPV4_RANGES: readonly Ipv4Range[] = [
  [0, 0, 0, 255, 0, 255, 0, 255],
  [10, 10, 0, 255, 0, 255, 0, 255],
  [127, 127, 0, 255, 0, 255, 0, 255],
  [169, 169, 254, 254, 0, 255, 0, 255],
  [172, 172, 16, 31, 0, 255, 0, 255],
  [192, 192, 168, 168, 0, 255, 0, 255],
  [100, 100, 64, 127, 0, 255, 0, 255],
  [192, 192, 0, 0, 0, 255, 0, 255],
  [198, 198, 18, 19, 0, 255, 0, 255],
  [198, 198, 51, 51, 100, 100, 0, 255],
  [203, 203, 0, 0, 113, 113, 0, 255],
  [224, 255, 0, 255, 0, 255, 0, 255],
];

/** Return true when an IP address is private, local, link-local, documentation, or otherwise non-public. */
export function isPrivateAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address).toLowerCase();
  if (isIpv4Address(normalized)) return isPrivateIpv4(ipv4Parts(normalized));
  const parts = expandIpv6(normalized);
  if (!parts) return true;
  if (isPrivateIpv6Range(parts)) return true;
  const mapped = mappedIpv4(parts);
  if (mapped) return isPrivateIpv4(mapped);
  return embeddedTransitionIpv4(parts).some((ip) => isPrivateIpv4(ip));
}

function stripIpv6Brackets(address: string): string {
  return address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
}

function isIpv4Address(address: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(address) && ipv4Parts(address).length === 4;
}

function ipv4Parts(address: string): number[] {
  const parts = address.split(".").map((part) => Number(part));
  return parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : [];
}

function isPrivateIpv4(parts: number[]): boolean {
  if (parts.length !== 4) return true;
  return NON_PUBLIC_IPV4_RANGES.some((range) => matchesIpv4Range(parts, range));
}

function matchesIpv4Range(parts: number[], range: Ipv4Range): boolean {
  return parts.every((part, index) => part >= range[index * 2] && part <= range[index * 2 + 1]);
}

function expandIpv6(address: string): number[] | null {
  const noZone = address.split("%")[0];
  const prepared = replaceIpv4Tail(noZone);
  const [head, tail, extra] = prepared.split("::");
  if (extra !== undefined) return null;
  const headParts = parseHextets(head);
  const tailParts = tail === undefined ? [] : parseHextets(tail);
  if (!headParts || !tailParts) return null;
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return null;
  return [...headParts, ...Array(missing).fill(0), ...tailParts];
}

function replaceIpv4Tail(address: string): string {
  const lastColon = address.lastIndexOf(":");
  const tail = lastColon >= 0 ? address.slice(lastColon + 1) : address;
  if (!isIpv4Address(tail)) return address;
  const [a, b, c, d] = ipv4Parts(tail);
  return `${address.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
}

function parseHextets(section: string): number[] | null {
  if (section.length === 0) return [];
  const parts = section.split(":");
  if (!parts.every((part) => HEX.test(part))) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

function isPrivateIpv6Range(parts: number[]): boolean {
  if (parts.length !== 8) return true;
  if (parts.every((part) => part === 0)) return true;
  if (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) return true;
  if ((parts[0] & 0xfe00) === 0xfc00) return true;
  if ((parts[0] & 0xffc0) === 0xfe80) return true;
  if ((parts[0] & 0xff00) === 0xff00) return true;
  return parts[0] === 0x2001 && parts[1] === 0x0db8;
}

function mappedIpv4(parts: number[]): number[] | null {
  const isMapped = parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;
  return isMapped ? hextetsToIpv4(parts[6], parts[7]) : null;
}

function embeddedTransitionIpv4(parts: number[]): number[][] {
  const embedded: number[][] = [];
  if (isNat64(parts)) embedded.push(hextetsToIpv4(parts[6], parts[7]));
  if (parts[0] === 0x2002) embedded.push(hextetsToIpv4(parts[1], parts[2]));
  if (isIpv4Compatible(parts)) embedded.push(hextetsToIpv4(parts[6], parts[7]));
  return embedded;
}

function isNat64(parts: number[]): boolean {
  return parts[0] === 0x0064 && parts[1] === 0xff9b && parts.slice(2, 6).every((part) => part === 0);
}

/** Deprecated IPv4-compatible ::/96 form (::a.b.c.d) — judge the embedded IPv4. */
function isIpv4Compatible(parts: number[]): boolean {
  return parts.slice(0, 6).every((part) => part === 0);
}

function hextetsToIpv4(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

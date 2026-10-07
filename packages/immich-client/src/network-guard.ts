import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

/**
 * Network policy for Immich connections (docs/planning/05, section 2):
 * - public addresses are always allowed,
 * - loopback, private (RFC 1918), CGNAT and unique-local addresses are allowed
 *   only when an administrator approved exactly this host and port,
 * - link-local, cloud metadata, unspecified, multicast and reserved addresses
 *   are never allowed, approved or not.
 */
export type AddressClass = 'public' | 'approval-required' | 'always-blocked';

export class ImmichTargetBlockedError extends Error {
  constructor(
    readonly code: 'TARGET_BLOCKED' | 'TARGET_NOT_APPROVED',
    readonly host: string,
    readonly port: number
  ) {
    super(code === 'TARGET_BLOCKED'
      ? `Immich target ${host}:${port} resolves to a blocked address`
      : `Immich target ${host}:${port} is a private address and has not been approved by an administrator`);
    this.name = 'ImmichTargetBlockedError';
  }
}

export interface EndpointApprovals {
  isApproved(host: string, port: number): Promise<boolean>;
}

type Range = { bytes: number[]; bits: number };

function ipv4Range(address: string, bits: number): Range {
  return { bytes: address.split('.').map(Number), bits };
}

function ipv6Range(address: string, bits: number): Range {
  return { bytes: parseIpv6(address)!, bits };
}

function inRange(bytes: number[], range: Range): boolean {
  for (let bit = 0; bit < range.bits; bit += 1) {
    const index = bit >> 3;
    const mask = 0x80 >> (bit & 7);
    if ((bytes[index]! & mask) !== (range.bytes[index]! & mask)) return false;
  }
  return true;
}

const IPV4_ALWAYS_BLOCKED = [
  ipv4Range('0.0.0.0', 8),
  ipv4Range('169.254.0.0', 16), // link-local, including 169.254.169.254 (AWS, GCP, Azure metadata)
  ipv4Range('100.100.100.200', 32), // Alibaba Cloud metadata
  ipv4Range('224.0.0.0', 4), // multicast
  ipv4Range('240.0.0.0', 4) // reserved and broadcast
];
const IPV4_APPROVAL_REQUIRED = [
  ipv4Range('127.0.0.0', 8),
  ipv4Range('10.0.0.0', 8),
  ipv4Range('172.16.0.0', 12),
  ipv4Range('192.168.0.0', 16),
  ipv4Range('100.64.0.0', 10)
];
const IPV6_ALWAYS_BLOCKED = [
  ipv6Range('::', 128), // unspecified
  ipv6Range('fe80::', 10), // link-local
  ipv6Range('fd00:ec2::254', 128), // AWS IPv6 metadata (inside the ULA range)
  ipv6Range('ff00::', 8), // multicast
  ipv6Range('64:ff9b::', 96), // NAT64 can hide an IPv4 target
  ipv6Range('2002::', 16), // 6to4
  ipv6Range('2001::', 32) // Teredo
];
const IPV6_APPROVAL_REQUIRED = [
  ipv6Range('::1', 128),
  ipv6Range('fc00::', 7) // unique local
];
const IPV4_MAPPED_PREFIX = ipv6Range('::ffff:0:0', 96);

/** Parses textual IPv6 (including `::` and an embedded IPv4 tail) into 16 bytes. */
function parseIpv6(value: string): number[] | undefined {
  let text = value.split('%')[0]!.toLowerCase();
  if (isIP(text) !== 6) return undefined;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const octets = tail[1]!.split('.').map(Number);
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${text.slice(0, -tail[1]!.length)}${high}:${low}`;
  }
  const halves = text.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length > 1 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...rest].map((group) => parseInt(group, 16));
  if (groups.length !== 8 || groups.some((group) => Number.isNaN(group))) return undefined;
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

export function classifyAddress(address: string): AddressClass {
  const family = isIP(address.split('%')[0]!);
  if (family === 4) {
    const bytes = address.split('.').map(Number);
    if (IPV4_ALWAYS_BLOCKED.some((range) => inRange(bytes, range))) return 'always-blocked';
    if (IPV4_APPROVAL_REQUIRED.some((range) => inRange(bytes, range))) return 'approval-required';
    return 'public';
  }
  if (family === 6) {
    const bytes = parseIpv6(address);
    if (!bytes) return 'always-blocked';
    if (inRange(bytes, IPV4_MAPPED_PREFIX)) return classifyAddress(bytes.slice(12).join('.'));
    if (IPV6_ALWAYS_BLOCKED.some((range) => inRange(bytes, range))) return 'always-blocked';
    if (IPV6_APPROVAL_REQUIRED.some((range) => inRange(bytes, range))) return 'approval-required';
    return 'public';
  }
  return 'always-blocked';
}

export interface Endpoint { host: string; port: number; }

/**
 * Normalizes an administrator-supplied host and port the same way URL parsing
 * normalizes a server URL, so approvals and connection checks compare equal.
 */
export function normalizeEndpoint(host: string, port: number): Endpoint | undefined {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  const trimmed = host.trim();
  if (!trimmed || /[\s/\\@?#]/.test(trimmed)) return undefined;
  const bracketed = trimmed.includes(':') && !trimmed.startsWith('[') ? `[${trimmed}]` : trimmed;
  try {
    const url = new URL(`http://${bracketed}:${port}`);
    const normalizedHost = url.hostname.replace(/^\[|\]$/g, '');
    if (!normalizedHost || url.pathname !== '/' || url.username || url.password) return undefined;
    return { host: normalizedHost, port };
  } catch {
    return undefined;
  }
}

export function endpointOf(url: URL): Endpoint {
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port };
}

export interface GuardedFetchOptions {
  approvals: EndpointApprovals;
  /** Replaceable in tests; the default resolves with the system resolver. */
  resolveHost?: (host: string) => Promise<string[]>;
}

async function resolveWithSystemResolver(host: string): Promise<string[]> {
  const records = await dnsLookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function verifiedAddress(endpoint: Endpoint, options: GuardedFetchOptions): Promise<string> {
  const addresses = isIP(endpoint.host)
    ? [endpoint.host]
    : await (options.resolveHost ?? resolveWithSystemResolver)(endpoint.host);
  if (addresses.length === 0) throw new Error(`Immich host ${endpoint.host} did not resolve`);
  const classes = addresses.map(classifyAddress);
  if (classes.includes('always-blocked')) throw new ImmichTargetBlockedError('TARGET_BLOCKED', endpoint.host, endpoint.port);
  if (classes.includes('approval-required') && !await options.approvals.isApproved(endpoint.host, endpoint.port)) {
    throw new ImmichTargetBlockedError('TARGET_NOT_APPROVED', endpoint.host, endpoint.port);
  }
  return addresses[0]!;
}

function requestHeaders(init: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init.headers).entries());
}

function toResponse(incoming: IncomingMessage, method: string): Response {
  const status = incoming.statusCode ?? 502;
  const headers = new Headers();
  for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) {
    headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
  }
  const hasNoBody = method === 'HEAD' || status === 204 || status === 205 || status === 304;
  if (hasNoBody) {
    incoming.resume();
    return new Response(null, { status, statusText: incoming.statusMessage, headers });
  }
  return new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, statusText: incoming.statusMessage, headers });
}

/**
 * A fetch replacement that connects only to an address it has verified:
 * the host is resolved once, every resolved address is checked against the
 * policy, and the socket is opened to exactly that address (so a second DNS
 * answer cannot redirect the connection). Redirects are never followed; a 3xx
 * response is returned as is. Connections are not pooled, so every request is
 * checked again against the current approvals.
 */
export function createGuardedFetch(options: GuardedFetchOptions): typeof fetch {
  return async (input, init = {}) => {
    if (typeof input !== 'string' && !(input instanceof URL)) throw new TypeError('Guarded fetch accepts a URL or string only');
    const url = new URL(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('Only http and https Immich URLs are supported');
    const endpoint = endpointOf(url);
    const address = await verifiedAddress(endpoint, options);
    const family = isIP(address);
    const method = (init.method ?? 'GET').toUpperCase();
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const requestOptions: RequestOptions = {
      method,
      hostname: endpoint.host,
      port: endpoint.port,
      path: `${url.pathname}${url.search}`,
      headers: requestHeaders(init),
      agent: false,
      signal: init.signal ?? undefined,
      lookup: (_hostname, lookupOptions, callback) => {
        const result = { address, family };
        if (lookupOptions.all) (callback as (error: null, addresses: typeof result[]) => void)(null, [result]);
        else callback(null, address, family);
      }
    };
    return new Promise<Response>((resolve, reject) => {
      const outgoing = send(requestOptions, (incoming) => resolve(toResponse(incoming, method)));
      outgoing.on('error', reject);
      const body = init.body;
      if (body === undefined || body === null) outgoing.end();
      else if (typeof body === 'string' || body instanceof Uint8Array) outgoing.end(body);
      else if (body instanceof ReadableStream) {
        const source = Readable.fromWeb(body as import('node:stream/web').ReadableStream);
        source.on('error', (error) => outgoing.destroy(error));
        source.pipe(outgoing);
      } else {
        outgoing.destroy(new TypeError('Unsupported request body type'));
      }
    });
  };
}

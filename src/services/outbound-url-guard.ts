import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { Agent } from "undici";

type LookupFn = (
  hostname: string,
  options: { all: true; verbatim: true }
) => Promise<LookupAddress[]>;
type FetchInitWithDispatcher = RequestInit & { dispatcher: Agent };

export interface ResolvedOutboundUrl {
  url: URL;
  hostname: string;
  addresses: LookupAddress[];
}

export interface PinnedOutboundFetch extends ResolvedOutboundUrl {
  fetch: typeof fetch;
  close: () => Promise<void>;
}

export interface OutboundFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: Headers;
}

export interface OutboundUrlGuardOptions {
  allowedProtocols: readonly string[];
  label: string;
  lookup?: LookupFn;
  fetchImpl?: typeof fetch;
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "local", "metadata", "metadata.google.internal"]);
const defaultLookup = dnsLookup as LookupFn;

const blockedIpRanges = new BlockList();
blockedIpRanges.addSubnet("0.0.0.0", 8, "ipv4");
blockedIpRanges.addSubnet("10.0.0.0", 8, "ipv4");
blockedIpRanges.addSubnet("100.64.0.0", 10, "ipv4");
blockedIpRanges.addSubnet("127.0.0.0", 8, "ipv4");
blockedIpRanges.addSubnet("169.254.0.0", 16, "ipv4");
blockedIpRanges.addSubnet("172.16.0.0", 12, "ipv4");
blockedIpRanges.addSubnet("192.168.0.0", 16, "ipv4");
blockedIpRanges.addSubnet("198.18.0.0", 15, "ipv4");
blockedIpRanges.addSubnet("224.0.0.0", 4, "ipv4");
blockedIpRanges.addSubnet("240.0.0.0", 4, "ipv4");
blockedIpRanges.addAddress("255.255.255.255", "ipv4");

blockedIpRanges.addAddress("::", "ipv6");
blockedIpRanges.addAddress("::1", "ipv6");
blockedIpRanges.addSubnet("fc00::", 7, "ipv6");
blockedIpRanges.addSubnet("fe80::", 10, "ipv6");
blockedIpRanges.addSubnet("ff00::", 8, "ipv6");

export function validateOutboundUrl(raw: string, options: OutboundUrlGuardOptions): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ${options.label}: ${raw}`);
  }

  if (!options.allowedProtocols.includes(url.protocol)) {
    throw new Error(
      `${options.label} must use ${formatProtocols(options.allowedProtocols)} - got "${url.protocol}"`
    );
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) {
    throw new Error(`${options.label} must include a host`);
  }

  validateHostname(hostname, options.label);
  validateIpAddress(hostname, options.label, "targets");

  return url;
}

export async function validateResolvedOutboundUrl(
  raw: string,
  options: OutboundUrlGuardOptions
): Promise<URL> {
  return (await resolveOutboundUrl(raw, options)).url;
}

export async function resolveOutboundUrl(
  raw: string,
  options: OutboundUrlGuardOptions
): Promise<ResolvedOutboundUrl> {
  const url = validateOutboundUrl(raw, options);
  const hostname = normalizeHostname(url.hostname);
  const ipVersion = isIP(hostname);
  if (ipVersion !== 0) {
    return {
      url,
      hostname,
      addresses: [{ address: hostname, family: ipVersion }],
    };
  }

  const resolver = options.lookup ?? defaultLookup;
  const addresses = (await resolver(hostname, { all: true, verbatim: true })).map((address) => ({
    address: normalizeHostname(address.address),
    family: address.family,
  }));
  if (addresses.length === 0) {
    throw new Error(`${options.label} hostname could not be resolved: ${hostname}`);
  }

  for (const { address } of addresses) {
    validateIpAddress(address, options.label, "resolves to");
  }

  return { url, hostname, addresses };
}

export async function fetchValidatedOutboundUrl(
  raw: string,
  init: RequestInit,
  options: OutboundUrlGuardOptions
): Promise<OutboundFetchResponse> {
  const target = await resolveOutboundUrl(raw, options);
  const dispatcher = createPinnedDispatcher(target, options.label);

  try {
    const response = await (options.fetchImpl ?? fetch)(target.url.toString(), {
      ...init,
      redirect: "manual",
      dispatcher,
    } as FetchInitWithDispatcher);
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      headers: response.headers,
    };
  } finally {
    await dispatcher.close();
  }
}

export async function createPinnedOutboundFetch(
  raw: string,
  options: OutboundUrlGuardOptions
): Promise<PinnedOutboundFetch> {
  const target = await resolveOutboundUrl(raw, options);
  const dispatcher = createPinnedDispatcher(target, options.label);
  let closed = false;

  return {
    ...target,
    fetch: async (input, init) => {
      assertPinnedFetchTarget(input, target, options.label);
      if (closed) throw new Error(`${options.label} pinned fetch is already closed`);

      return (options.fetchImpl ?? fetch)(input, {
        ...init,
        redirect: "manual",
        dispatcher,
      } as FetchInitWithDispatcher);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await dispatcher.close();
    },
  };
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
}

function validateHostname(hostname: string, label: string): void {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "local") {
    throw new Error(`${label} targets loopback hostname: ${hostname}`);
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`${label} targets metadata hostname: ${hostname}`);
  }
}

function validateIpAddress(hostname: string, label: string, verb: "targets" | "resolves to"): void {
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    if (blockedIpRanges.check(hostname, "ipv4")) {
      throw new Error(`${label} ${verb} a private/loopback/metadata address: ${hostname}`);
    }
    return;
  }

  if (ipVersion === 6) {
    const mappedIpv4 = getMappedIpv4(hostname);
    if (mappedIpv4 && blockedIpRanges.check(mappedIpv4, "ipv4")) {
      throw new Error(`${label} ${verb} a private/loopback/metadata address: ${hostname}`);
    }
    if (blockedIpRanges.check(hostname, "ipv6")) {
      throw new Error(`${label} ${verb} a private/loopback/metadata address: ${hostname}`);
    }
  }
}

function getMappedIpv4(hostname: string): string | undefined {
  const dotted = hostname.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];

  const hex = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return undefined;

  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function formatProtocols(protocols: readonly string[]): string {
  if (protocols.length === 1) return protocols[0];
  return `${protocols.slice(0, -1).join(", ")} or ${protocols[protocols.length - 1]}`;
}

function createPinnedDispatcher(target: ResolvedOutboundUrl, label: string): Agent {
  return new Agent({
    connect: {
      lookup: createPinnedLookup(target, label),
    },
  });
}

function createPinnedLookup(target: ResolvedOutboundUrl, label: string): LookupFunction {
  return (hostname, options, callback) => {
    const requestedFamily = normalizeLookupFamily(options.family);
    const normalizedHostname = normalizeHostname(hostname);
    if (normalizedHostname !== target.hostname) {
      callbackWithError(
        callback,
        new Error(`${label} redirected DNS lookup to unvalidated hostname: ${hostname}`)
      );
      return;
    }

    const addresses = selectPinnedAddresses(target.addresses, requestedFamily);
    if (addresses.length === 0) {
      callbackWithError(
        callback,
        new Error(`${label} has no validated IPv${requestedFamily} address for ${hostname}`)
      );
      return;
    }

    if (options.all) {
      callback(null, addresses);
      return;
    }

    callback(null, addresses[0].address, addresses[0].family);
  };
}

function callbackWithError(
  callback: Parameters<LookupFunction>[2],
  error: NodeJS.ErrnoException
): void {
  callback(error, "", 0);
}

function normalizeLookupFamily(family: LookupOptions["family"]): number | undefined {
  if (family === "IPv4") return 4;
  if (family === "IPv6") return 6;
  if (family === 0) return undefined;
  return family;
}

function selectPinnedAddresses(
  addresses: LookupAddress[],
  family: number | undefined
): LookupAddress[] {
  if (family === 4 || family === 6) {
    return addresses.filter((address) => address.family === family);
  }
  return addresses;
}

function assertPinnedFetchTarget(
  input: RequestInfo | URL,
  target: ResolvedOutboundUrl,
  label: string
): void {
  const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
  let requestedUrl: URL;
  try {
    requestedUrl = new URL(rawUrl);
  } catch {
    throw new Error(`${label} attempted fetch to a non-absolute URL: ${rawUrl}`);
  }

  if (requestedUrl.origin !== target.url.origin) {
    throw new Error(`${label} attempted fetch to unvalidated origin: ${requestedUrl.origin}`);
  }
}

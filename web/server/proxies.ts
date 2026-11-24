import { isIP } from 'node:net';

// The client's address behind trusted reverse proxies (audit M1). The TCP peer is the only address nobody can forge;
// a client-IP header (X-Forwarded-For by default, or Cf-Connecting-Ip, X-Real-IP… with KLATCHLY_CLIENT_IP_HEADER) is read
// only when that peer is a trusted proxy (KLATCHLY_TRUSTED_PROXIES, CIDR list, default loopback). The header is then
// walked from the right, skipping the trusted proxies, and the first address that is not one is the client: an
// address a client wrote at the left of the header itself is never reached while a proxy we trust appended after it.
// Without a trusted peer, the socket address is the client, whatever the header says.

export interface Cidr {
  v6: boolean;
  net: bigint;
  prefix: number;
}

interface Addr {
  v6: boolean;
  n: bigint;
}

const v4ToBig = (ip: string): bigint => ip.split('.').reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);

function v6ToBig(ip: string): bigint | null {
  let s = ip;
  // An IPv4 tail (::ffff:192.0.2.1, 64:ff9b::192.0.2.1): two groups.
  const tail = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const v = Number(v4ToBig(tail[1]!));
    s = `${s.slice(0, tail.index)}:${(v >>> 16).toString(16)}:${(v & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...new Array<string>(fill).fill('0'), ...rest];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

const MAPPED = 0xffffn << 32n;

/**
 * An address as it may come from a socket or a header: IPv4, IPv6 (zone, brackets dropped), IPv4-mapped IPv6 (taken
 * as the IPv4 address), with a port (`192.0.2.1:443`, `[2001:db8::1]:443`). Null when it is not one.
 */
function parse(raw: string): Addr | null {
  let s = raw.trim();
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(s);
  if (v4port) s = v4port[1]!;
  const bracket = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(s);
  if (bracket) s = bracket[1]!;
  s = s.split('%')[0]!;
  const kind = isIP(s);
  if (kind === 4) return { v6: false, n: v4ToBig(s) };
  if (kind !== 6) return null;
  const n = v6ToBig(s);
  if (n === null) return null;
  if (n >> 32n === 0xffffn) return { v6: false, n: n & 0xffffffffn };
  return { v6: true, n };
}

/** The canonical text of an address (an IPv4-mapped one as plain IPv4), or null. */
export function canonicalIp(raw: string): string | null {
  const a = parse(raw);
  if (!a) return null;
  if (!a.v6) return [24n, 16n, 8n, 0n].map((sh) => String((a.n >> sh) & 255n)).join('.');
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(((a.n >> BigInt(i * 16)) & 0xffffn).toString(16));
  // The longest run of zero groups (two or more) becomes '::' (RFC 5952).
  let best = -1;
  let len = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > len && j - i > 1) [best, len] = [i, j - i];
    i = j;
  }
  if (best < 0) return groups.join(':');
  return `${groups.slice(0, best).join(':')}::${groups.slice(best + len).join(':')}`;
}

/**
 * A comma-separated list of CIDR blocks (a bare address is a block of one); throws on a malformed entry, so that a
 * typo fails the start instead of trusting nothing (or everything) silently. Empty: no proxy is trusted.
 */
export function parseCidrs(list: string): Cidr[] {
  const out: Cidr[] = [];
  for (const entry of list.split(',').map((e) => e.trim()).filter(Boolean)) {
    const [ip = '', bits, extra] = entry.split('/');
    const a = extra === undefined ? parse(ip) : null;
    const max = a?.v6 ? 128 : 32;
    // An IPv4-mapped block (::ffff:10.0.0.0/104) counts in IPv4 bits.
    const mapped = a && !a.v6 && ip.includes(':');
    const given = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) - (mapped ? 96 : 0) : NaN;
    if (!a || !(given >= 0 && given <= max)) throw new Error(`KLATCHLY_TRUSTED_PROXIES: not an address or CIDR block: ${JSON.stringify(entry)}`);
    const shift = BigInt(max - given);
    out.push({ v6: a.v6, net: (a.n >> shift) << shift, prefix: given });
  }
  return out;
}

function inBlocks(a: Addr, blocks: readonly Cidr[]): boolean {
  return blocks.some((b) => {
    if (b.v6 !== a.v6) return false;
    const shift = BigInt((b.v6 ? 128 : 32) - b.prefix);
    return (a.n >> shift) << shift === b.net;
  });
}

/** Whether `ip` is in one of the blocks (false for what is not an address). */
export function isTrusted(ip: string | undefined, blocks: readonly Cidr[]): boolean {
  const a = ip === undefined ? null : parse(ip);
  return !!a && inBlocks(a, blocks);
}

export const DEFAULT_TRUSTED_PROXIES = '127.0.0.1/32,::1/128';

/** KLATCHLY_CLIENT_IP_HEADER: a header name (lower case), x-forwarded-for by default. */
export function parseHeaderName(v: string | undefined): string {
  const h = (v ?? '').trim().toLowerCase() || 'x-forwarded-for';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(h)) throw new Error(`KLATCHLY_CLIENT_IP_HEADER: not a header name: ${JSON.stringify(v)}`);
  return h;
}

/**
 * The client's address: `peer` (the socket's remote address) unless it is a trusted proxy, then the first address
 * of `header` (the client-IP header's value, a comma-separated list: X-Forwarded-For; a single address: Cf-Connecting-Ip)
 * that is not a trusted proxy, read from the right. A malformed entry stops the walk at the last trusted hop (never
 * an address further left, which the client could have written). 'unknown' without a peer (in-process requests).
 */
export function clientAddress(peer: string | undefined, header: string | undefined, trusted: readonly Cidr[]): string {
  const p = peer === undefined ? null : canonicalIp(peer);
  if (!p) return 'unknown';
  if (!isTrusted(p, trusted) || !header) return p;
  let hop = p;
  const entries = header.split(',');
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!.trim();
    if (!e) continue;
    const ip = e.length <= 64 ? canonicalIp(e) : null;
    if (!ip) return hop;
    if (!isTrusted(ip, trusted)) return ip;
    hop = ip;
  }
  return hop;
}

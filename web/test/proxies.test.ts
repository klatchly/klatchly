import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalIp, clientAddress, DEFAULT_TRUSTED_PROXIES, isTrusted, parseCidrs, parseHeaderName } from '../server/proxies.js';

// The client's address behind trusted proxies (server/proxies.ts, audit M1): the header is believed only from a
// trusted peer, walked from the right; the cases of docs/self-hosting.md (host Caddy, Docker gateway, cloudflared on the host or
// in a container, Cloudflare → Caddy).

const loop = parseCidrs(DEFAULT_TRUSTED_PROXIES);

test('addresses: IPv4, IPv6 (compressed, zone, brackets, port), IPv4-mapped taken as IPv4; junk is not one', () => {
  assert.equal(canonicalIp('192.0.2.7'), '192.0.2.7');
  assert.equal(canonicalIp('::ffff:192.0.2.7'), '192.0.2.7');
  assert.equal(canonicalIp('::FFFF:c000:0207'), '192.0.2.7');
  assert.equal(canonicalIp('2001:DB8:0:0:0:0:0:1'), '2001:db8::1');
  assert.equal(canonicalIp('[2001:db8::1]:8443'), '2001:db8::1');
  assert.equal(canonicalIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(canonicalIp('192.0.2.7:51234'), '192.0.2.7');
  assert.equal(canonicalIp('::1'), '::1');
  for (const bad of ['', 'unknown', '256.1.1.1', '1.2.3', '2001:db8::1::2', 'example.com', '<script>']) assert.equal(canonicalIp(bad), null, bad);
});

test('CIDR lists: blocks and bare addresses, IPv4-mapped blocks; a malformed entry fails the start', () => {
  const b = parseCidrs(' 10.89.0.1, 172.16.0.0/12 ,fd00::/8, ::ffff:192.168.0.0/112 ');
  assert.ok(isTrusted('10.89.0.1', b));
  assert.ok(!isTrusted('10.89.0.2', b));
  assert.ok(isTrusted('172.31.255.254', b) && !isTrusted('172.32.0.1', b));
  assert.ok(isTrusted('fd12:3456::1', b) && !isTrusted('fe80::1', b));
  assert.ok(isTrusted('192.168.4.5', b) && isTrusted('::ffff:192.168.4.5', b));
  assert.ok(isTrusted('::ffff:127.0.0.1', loop) && isTrusted('::1', loop) && !isTrusted('127.0.0.2', loop));
  assert.deepEqual(parseCidrs(''), []);
  for (const bad of ['10.0.0.0/33', '::/129', 'localhost', '10.0.0.1/8/1', '10.0.0.0/x', '10.0.0.0/']) assert.throws(() => parseCidrs(bad), /KLATCHLY_TRUSTED_PROXIES/, bad);
  assert.equal(parseHeaderName(undefined), 'x-forwarded-for');
  assert.equal(parseHeaderName('Cf-Connecting-IP'), 'cf-connecting-ip');
  assert.throws(() => parseHeaderName('x forwarded'), /KLATCHLY_CLIENT_IP_HEADER/);
});

test('untrusted peer: the socket address, whatever the header says (no spoofing the owner, no fresh address per try)', () => {
  assert.equal(clientAddress('198.51.100.9', '192.0.2.1', loop), '198.51.100.9');
  assert.equal(clientAddress('::ffff:198.51.100.9', '127.0.0.1, 192.0.2.1', loop), '198.51.100.9');
  assert.equal(clientAddress(undefined, '192.0.2.1', loop), 'unknown', 'no socket (in-process request)');
  // The owner's host Caddy reached through the Docker port: the peer is the network's gateway, not loopback.
  assert.equal(clientAddress('10.89.0.1', '203.0.113.5', loop), '10.89.0.1', 'gateway not declared: its own address');
  assert.equal(clientAddress('10.89.0.1', '203.0.113.5', parseCidrs(`${DEFAULT_TRUSTED_PROXIES},10.89.0.1`)), '203.0.113.5', 'declared: the client');
});

test('trusted peer: the header walked from the right, skipping trusted hops; junk stops at the last trusted hop', () => {
  const t = parseCidrs('127.0.0.1/32,::1/128,10.0.0.0/8');
  // Caddy replaces XFF with the client: one entry.
  assert.equal(clientAddress('127.0.0.1', '203.0.113.5', t), '203.0.113.5');
  // A client wrote its own XFF and a proxy appended after it: the appended address wins, never the forged one.
  assert.equal(clientAddress('127.0.0.1', '192.0.2.66, 203.0.113.5', t), '203.0.113.5');
  // Two proxies of ours (10/8) after the client.
  assert.equal(clientAddress('127.0.0.1', '192.0.2.66, 203.0.113.5, 10.1.2.3, 10.9.9.9', t), '203.0.113.5');
  assert.equal(clientAddress('127.0.0.1', '2001:db8::5', t), '2001:db8::5');
  assert.equal(clientAddress('127.0.0.1', '[2001:db8::5]:4711', t), '2001:db8::5');
  // Only trusted hops: the leftmost of them (the request started inside).
  assert.equal(clientAddress('127.0.0.1', '10.1.2.3, 127.0.0.1', t), '10.1.2.3');
  // Malformed: never further left than the last trusted hop.
  assert.equal(clientAddress('127.0.0.1', '203.0.113.5, bogus', t), '127.0.0.1');
  assert.equal(clientAddress('127.0.0.1', '203.0.113.5, bogus, 10.1.2.3', t), '10.1.2.3');
  assert.equal(clientAddress('127.0.0.1', `${'1'.repeat(70)}`, t), '127.0.0.1', 'over-long entry');
  assert.equal(clientAddress('127.0.0.1', '', t), '127.0.0.1');
});

test('Cloudflare: cloudflared → Caddy → Klatchly unchanged; cloudflared → Klatchly with Cf-Connecting-Ip, on the host or in a container', () => {
  // cloudflared (host service) → Caddy on 127.0.0.1 → Klatchly through the Docker port: Caddy (no trusted_proxies of its
  // own) sets XFF to cloudflared's 127.0.0.1, as before this change; Caddy configured to trust cloudflared passes the
  // client (docs/self-hosting.md, "Cloudflare Tunnel").
  const gw = parseCidrs(`${DEFAULT_TRUSTED_PROXIES},10.89.0.1`);
  assert.equal(clientAddress('10.89.0.1', '127.0.0.1', gw), '127.0.0.1');
  assert.equal(clientAddress('10.89.0.1', '203.0.113.5', gw), '203.0.113.5');
  // cloudflared straight to Klatchly: its single-address header (KLATCHLY_CLIENT_IP_HEADER=cf-connecting-ip).
  assert.equal(clientAddress('127.0.0.1', '203.0.113.5', loop), '203.0.113.5', 'cloudflared on the host, Klatchly on the host');
  const docker = parseCidrs('172.18.0.0/16');
  assert.equal(clientAddress('172.18.0.4', '2001:db8::77', docker), '2001:db8::77', 'cloudflared in a container of a declared network');
  assert.equal(clientAddress('172.19.0.4', '2001:db8::77', docker), '172.19.0.4', 'another network: not believed');
  // A client sending Cf-Connecting-Ip itself to an exposed port: ignored.
  assert.equal(clientAddress('198.51.100.9', '203.0.113.5', docker), '198.51.100.9');
});

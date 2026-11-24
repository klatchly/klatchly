import { test } from 'node:test';
import assert from 'node:assert/strict';

// clientIp() in the app (server/context.ts) with cloudflared straight in front: Cf-Connecting-Ip believed only from
// the declared Docker network. Its own process: the config is read once, so the variables are set before the import.
process.env.KLATCHLY_TRUSTED_PROXIES = '172.18.0.0/16';
process.env.KLATCHLY_CLIENT_IP_HEADER = 'Cf-Connecting-Ip';
const { createApp } = await import('../server/app.js');
const { config } = await import('../server/config.js');
const { clientIp } = await import('../server/context.js');
const { Hono } = await import('hono');

const peer = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });

test('cloudflared in a container: its Cf-Connecting-Ip is the client; X-Forwarded-For is not the header any more', async () => {
  const probe = new Hono().get('/', (c) => c.text(clientIp(c)));
  const ip = async (address: string, headers: Record<string, string>) => (await probe.request('/', { headers }, peer(address))).text();
  assert.equal(await ip('172.18.0.4', { 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': '192.0.2.1' }), '203.0.113.5');
  assert.equal(await ip('172.18.0.4', { 'x-forwarded-for': '192.0.2.1' }), '172.18.0.4', 'only the configured header');
  assert.equal(await ip('198.51.100.9', { 'cf-connecting-ip': '203.0.113.5' }), '198.51.100.9', 'exposed port: the socket');
  assert.equal(await ip('::ffff:172.18.0.4', { 'cf-connecting-ip': '2001:db8::5' }), '2001:db8::5');
});

test('rate limits follow it: a stranger sending a new Cf-Connecting-Ip each time is still one address', async () => {
  const app = createApp();
  const options = (address: string, n: number) =>
    app.request('/api/auth/options', { method: 'POST', headers: { origin: config().origin, 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${n}` } }, peer(address));
  const statuses: number[] = [];
  for (let n = 1; n <= 31; n++) statuses.push((await options('198.51.100.20', n)).status);
  assert.equal(statuses.filter((s) => s === 200).length, 30);
  assert.equal(statuses.at(-1), 429, 'the 31st from the same socket address is limited, header or not');
  // Through cloudflared, each visitor its own bucket.
  for (let n = 1; n <= 31; n++) assert.equal((await options('172.18.0.4', n)).status, 200);
});

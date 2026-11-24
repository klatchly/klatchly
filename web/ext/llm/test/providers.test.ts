import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '#core/app.js';
import { config } from '#core/config.js';
import { sessions, store } from '#core/context.js';
import { Registry } from '#core/registry.js';
import { sha256 } from '#core/sessions.js';
import { packages } from '../../packages.server.js';
import type { ChatMessages } from '../api.js';
import { completeFor, labelFor, parseModels, resetModelsCache, setLlmFetch, testProvider, use } from '../server/llm.js';
import { addProvider, cleanName, cleanUrl, isDefault, provider, providers, resetStore, routeOf, setModels, updateProvider, validKey } from '../server/store.js';

// Providers set in Settings (store.ts, routes.ts): the server's configuration as provider 'env' (migration), keys
// write-only (0600 files, never in an answer or a log line, never sent to another provider), URLs checked, models
// enabled per provider, the uses' routes over several providers, the step-up of sensitive changes. All on a fake
// network: two made-up providers.

const dir = mkdtempSync(join(tmpdir(), 'klatchly-llm-providers-'));
const SERVER_KEY = 'sk-server-0123456789';
const OR_KEY = 'sk-or-v1-abcdefabcdef';
writeFileSync(join(dir, 'llm_key'), `${SERVER_KEY}\n`);
Object.assign(process.env, { KLATCHLY_LLM_URL: 'http://9router:20128/v1/', KLATCHLY_LLM_MODEL: 'cx/model-a', KLATCHLY_LLM_FALLBACK: 'cx/model-b', KLATCHLY_LLM_KEY_FILE: join(dir, 'llm_key') });
delete process.env.KLATCHLY_LLM_LABEL;

/** Every request the fake network got: where, with which key (the Bearer), redirect mode. */
const seen: { url: string; auth: string | null; redirect?: string; model?: string }[] = [];
/** Per host, a chat completion's status (200 by default). */
const chatStatus: Record<string, number> = {};
setLlmFetch(async (input, init) => {
  const url = new URL(String(input));
  const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
  const body = init?.body ? (JSON.parse(String(init.body)) as { model: string }) : undefined;
  seen.push({ url: url.href, auth, redirect: init?.redirect, model: body?.model });
  const path = url.pathname;
  if (url.host === '9router:20128') {
    if (auth !== `Bearer ${SERVER_KEY}`) return new Response('{}', { status: 401 });
    if (path === '/v1/models')
      return Response.json({ data: [{ id: 'cx/model-a', owned_by: 'cx' }, { id: 'cx/model-b', owned_by: 'cx' }, { id: 'cx/model-a-review' }, { id: 'cx/search', kind: 'webSearch' }, { id: 'combo-1', owned_by: 'combo' }] });
  }
  if (url.host === 'or.test') {
    if (path === '/api/v1/models') return Response.json({ data: [{ id: 'vendor/m1', name: 'Vendor M1', architecture: { output_modalities: ['text'] } }, { id: 'vendor/img', architecture: { output_modalities: ['image'] } }] });
    if (auth !== `Bearer ${OR_KEY}`) return new Response('{}', { status: 401 });
    if (path === '/api/v1/key') return Response.json({ data: { label: 'x' } });
  }
  // Too big a model list; not JSON (its text must never show in an error).
  if (url.host === 'big.test') return new Response(JSON.stringify({ data: [{ id: 'x'.repeat(3 * 1024 * 1024) }] }));
  if (url.host === 'junk.test') return new Response('<html>secret-snippet</html>', { headers: { 'content-type': 'application/json' } });
  if (url.host === 'redirect.test') return new Response(null, { status: 302, headers: { location: 'http://9router:20128/v1/models' } });
  if (path.endsWith('/chat/completions')) {
    const status = chatStatus[url.host] ?? 200;
    return status === 200 ? Response.json({ choices: [{ message: { content: `${url.host} ${body!.model}` } }] }) : new Response('{}', { status });
  }
  return new Response('{}', { status: 404 });
}, undefined);

// Log lines, to check no key ever shows in them.
const logged: string[] = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => (logged.push(String(chunk)), write(chunk, ...rest))) as typeof process.stdout.write;
after(() => void (process.stdout.write = write));

const MSG: ChatMessages = [{ role: 'user', content: 'ping' }];
const LABEL = { en: 'A feature' };

test('validation: http(s) URLs without credentials, query or fragment; names; keys as a header carries them', () => {
  assert.equal(cleanUrl('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/v1');
  assert.equal(cleanUrl(' http://9router:20128/v1 '), 'http://9router:20128/v1');
  for (const bad of ['file:///etc/passwd', 'ftp://x/v1', 'javascript:alert(1)', 'https://u:p@x.test/v1', 'https://x.test/v1?key=1', 'https://x.test/v1#a', 'not a url', 7, `https://x.test/${'a'.repeat(300)}`]) assert.equal(cleanUrl(bad), null, String(bad));
  assert.equal(cleanName('  OpenRouter '), 'OpenRouter');
  for (const bad of ['', '   ', 'a\u0007b', 'x'.repeat(41), 3]) assert.equal(cleanName(bad), null, String(bad));
  assert.ok(validKey(OR_KEY) && !validKey('two words') && !validKey('') && !validKey('é') && !validKey('a\nb'));
});

test('models: chat models only (no "-review", no router tools, no image-only), names kept', () => {
  assert.deepEqual(
    parseModels({ data: [{ id: 'b/x', name: 'B X' }, { id: 'a/y-review' }, { id: 'a/search', kind: 'webSearch' }, { id: 'a/z', kind: 'llm' }, { id: 'v/img', architecture: { output_modalities: ['image'] } }, { id: 'bad id' }, { id: 'b/x' }] }),
    [{ id: 'a/z' }, { id: 'b/x', name: 'B X' }],
  );
  assert.deepEqual(parseModels({}), []);
});

test('migration: the server configuration is provider "env" with every model it lists; defaults and legacy routes kept', async () => {
  resetStore();
  const [env, ...rest] = providers();
  assert.deepEqual(rest, []);
  assert.deepEqual(
    { id: env!.id, kind: env!.kind, name: env!.name, url: env!.url, models: env!.models, fromServer: env!.fromServer },
    { id: 'env', kind: '9router', name: '9router', url: 'http://9router:20128/v1', models: null, fromServer: true },
  );
  // A use left on the defaults: KLATCHLY_LLM_MODEL then KLATCHLY_LLM_FALLBACK, on the server's provider, with its key.
  const off = use({ id: 'demo.one', label: LABEL });
  assert.deepEqual(routeOf('demo.one'), { model: { provider: 'env', model: 'cx/model-a' }, fallback: { provider: 'env', model: 'cx/model-b' } });
  assert.equal(await completeFor('demo.one', MSG), '9router:20128 cx/model-a');
  assert.equal(seen.at(-1)!.auth, `Bearer ${SERVER_KEY}`);
  // A use with a choice from before 1.1: adopted the first time, never again.
  use({ id: 'demo.two', label: LABEL, legacy: { model: 'cx/model-b', fallback: null } });
  assert.deepEqual(routeOf('demo.two'), { model: { provider: 'env', model: 'cx/model-b' }, fallback: null });
  const off2 = use({ id: 'demo.two', label: LABEL, legacy: { model: 'cx/model-a', fallback: 'cx/model-b' } });
  assert.deepEqual(routeOf('demo.two')!.model, { provider: 'env', model: 'cx/model-b' }, 'not adopted twice');
  // Kept on disk: read again (as after a restart), the same.
  resetStore();
  assert.deepEqual(routeOf('demo.two'), { model: { provider: 'env', model: 'cx/model-b' }, fallback: null });
  assert.ok(isDefault('demo.one') && !isDefault('demo.two'));
  off();
  off2();
});

test('settings API: providers with write-only keys, enabled models, routes over two providers, step-up', async () => {
  resetStore();
  resetModelsCache();
  if (!store.read().credentials.length) store.mutate((s) => void s.credentials.push({ id: 'cred', publicKey: 'x', counter: 0, createdAt: '2026-01-01T00:00:00Z', label: 'test' }));
  const sid = store.mutate((s) => sessions.create(s));
  const r = new Registry(packages);
  const app = createApp(r);
  await r.start();
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const res = await app.request(`/api/llm${path}`, {
      method,
      headers: { cookie: `sid=${sid}`, ...(method !== 'GET' ? { origin: config().origin, 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    assert.ok(!text.includes(OR_KEY) && !text.includes(SERVER_KEY), `no key in ${method} ${path}`);
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> & { error?: string } };
  };

  // Adding: checked, then the key kept apart (0600) and never shown again.
  for (const bad of [{ kind: 'openrouter', name: 'OR', url: 'file:///x', key: OR_KEY }, { kind: 'nope', name: 'OR', url: 'https://or.test/api/v1' }, { kind: 'openai', name: 'OR', url: 'https://or.test/api/v1', extra: 1 }]) {
    assert.equal((await call('/providers', 'POST', bad)).body.error, 'bad_request', JSON.stringify(bad));
  }
  assert.equal((await call('/providers', 'POST', { kind: 'openrouter', name: 'OR', url: 'https://or.test/api/v1' })).body.error, 'key_required');
  const added = await call('/providers', 'POST', { kind: 'openrouter', name: 'OpenRouter', url: 'https://or.test/api/v1', key: OR_KEY });
  assert.equal(added.status, 200);
  const id = added.body.id as string;
  assert.match(id, /^p-[a-z0-9]{8}$/);
  assert.deepEqual(added.body, { id, kind: 'openrouter', name: 'OpenRouter', url: 'https://or.test/api/v1', fromServer: false, keySet: true, all: false });
  for (const f of ['llm.json', 'llm-keys.json']) assert.equal(statSync(join(config().dataDir, f)).mode & 0o777, 0o600, f);
  assert.ok(!readFileSync(join(config().dataDir, 'llm.json'), 'utf8').includes(OR_KEY), 'the settings file holds no key');
  assert.ok(readFileSync(join(config().dataDir, 'llm-keys.json'), 'utf8').includes(OR_KEY), 'the key file does');
  const list = (await call('/providers')).body.providers as { id: string; keySet: boolean; fromServer: boolean }[];
  assert.deepEqual(list.map((p) => [p.id, p.fromServer, p.keySet]), [['env', true, true], [id, false, true]]);

  // Its models: what it lists (names kept, image models left out), none enabled yet; ticked, and one by hand.
  type Items = { all: boolean; reachable: boolean; items: { id: string; name?: string; listed: boolean; enabled: boolean }[] };
  let models = (await call(`/providers/${id}/models`)).body as unknown as Items;
  assert.deepEqual(models, { reachable: true, all: false, items: [{ id: 'vendor/m1', name: 'Vendor M1', listed: true, enabled: false }] });
  assert.equal((await call(`/providers/${id}/models`, 'PUT', { models: null })).body.error, 'bad_request', '"all" is the server provider\'s only');
  assert.equal((await call(`/providers/${id}/models`, 'PUT', { models: ['vendor/m1', '../x'] })).body.error, 'bad_request');
  assert.equal((await call(`/providers/${id}/models`, 'PUT', { models: ['vendor/m1', 'vendor/by-hand'] })).status, 200);
  models = (await call(`/providers/${id}/models`)).body as unknown as Items;
  assert.deepEqual(models.items.map((m) => [m.id, m.listed, m.enabled]), [['vendor/m1', true, true], ['vendor/by-hand', false, true]]);
  // The server's: every model it lists until picked (its tools and reviewers left out).
  models = (await call('/providers/env/models')).body as unknown as Items;
  assert.deepEqual([models.all, models.items.map((m) => m.id)], [true, ['combo-1', 'cx/model-a', 'cx/model-b']]);

  // Test: its list, and the key checked at no cost (OpenRouter's /key).
  const t = (await call(`/providers/${id}/test`, 'POST')).body;
  assert.deepEqual([t.ok, t.models, t.keyChecked], [true, 1, true]);
  assert.deepEqual([(await call('/providers/env/test', 'POST')).body.ok, (await call('/providers/env/test', 'POST')).body.keyChecked], [true, false]);

  // Default models: the enabled models of both, a use on one of each.
  const routes = (await call('/routes')).body as { uses: { id: string }[]; choices: { items: { provider: string; model: string }[] } };
  // The uses of the packages composed in (KLATCHLY_PACKAGES: the public tree has no ask).
  const has = (id: string) => packages.some((p) => p.id === id);
  const uses = [...(has('writing') ? ['writing.translate', 'writing.assist', 'writing.image'] : []), ...(has('ask') ? ['ask.answer'] : [])];
  assert.deepEqual(routes.uses.map((u) => u.id), uses);
  assert.deepEqual(routes.choices.items.map((x) => `${x.provider}:${x.model}`), ['env:combo-1', 'env:cx/model-a', 'env:cx/model-b', `${id}:vendor/m1`, `${id}:vendor/by-hand`]);
  const set = (model: unknown, fallback: unknown) => call('/routes', 'PUT', { 'writing.translate': { model, fallback } });
  assert.equal((await set({ provider: id, model: 'vendor/img' }, 'none')).body.error, 'unknown_model', 'not enabled');
  assert.equal((await set({ provider: 'p-zzzzzzzz', model: 'vendor/m1' }, 'none')).body.error, 'unknown_model', 'no such provider');
  assert.equal((await call('/routes', 'PUT', { 'other.use': null })).body.error, 'bad_request', 'not a registered use');
  assert.equal((await set({ provider: id, model: 'vendor/m1' }, { provider: 'env', model: 'cx/model-a' })).status, 200);
  const before = seen.length;
  assert.equal(await completeFor('writing.translate', MSG), 'or.test vendor/m1');
  assert.deepEqual(labelFor('writing.translate'), { en: 'OpenRouter' }, "who answers: the provider's name");
  // Its fallback on the other provider, each call with its own key only.
  chatStatus['or.test'] = 500;
  assert.equal(await completeFor('writing.translate', MSG), '9router:20128 cx/model-a');
  delete chatStatus['or.test'];
  for (const s of seen.slice(before)) {
    assert.equal(s.auth, new URL(s.url).host === 'or.test' ? `Bearer ${OR_KEY}` : `Bearer ${SERVER_KEY}`, s.url);
    assert.equal(s.redirect, 'manual');
  }
  // The Default models' Test: that model alone.
  assert.equal((await call('/test', 'POST', { provider: id, model: 'vendor/m1' })).body.ok, true);

  // Editing: the key replaced or kept, never cleared for a kind that needs one; the server's: its name only.
  assert.equal((await call(`/providers/${id}`, 'PUT', { key: null })).body.error, 'key_required');
  assert.equal((await call(`/providers/${id}`, 'PUT', { name: 'OR', url: 'https://or.test/api/v1/' })).body.name, 'OR');
  assert.equal((await call('/providers/env', 'PUT', { url: 'http://elsewhere.test/v1' })).body.error, 'server_provider');
  assert.equal((await call('/providers/env', 'PUT', { key: 'sk-other' })).body.error, 'server_provider');
  assert.equal((await call('/providers/env', 'PUT', { name: 'My router' })).body.name, 'My router');
  assert.equal((await call('/providers/env', 'DELETE')).body.error, 'server_provider');

  // A provider that redirects: an error, the redirect not followed with its key.
  const red = (await call('/providers', 'POST', { kind: 'openai', name: 'Redirects', url: 'https://redirect.test/v1', key: 'sk-redirect' })).body.id as string;
  const n = seen.length;
  assert.deepEqual([(await call(`/providers/${red}/test`, 'POST')).body.error], ['models 302']);
  assert.deepEqual(seen.slice(n).map((s) => new URL(s.url).host), ['redirect.test'], 'nothing sent where it points');

  // Sensitive changes need a recent sign-in or step-up; choosing models does not.
  store.mutate((s) => void (s.sessions.find((x) => x.hash === sha256(sid))!.authAt = Date.now() - 3600_000));
  for (const [path, method, body] of [['/providers', 'POST', { kind: 'openai', name: 'X', url: 'https://x.test/v1' }], [`/providers/${id}`, 'PUT', { name: 'Y' }], [`/providers/${id}`, 'DELETE', undefined]] as const) {
    const res = await call(path, method, body);
    assert.deepEqual([res.status, res.body.error], [403, 'step_up'], `${method} ${path}`);
  }
  assert.equal((await call(`/providers/${id}/models`, 'PUT', { models: ['vendor/m1'] })).status, 200);
  store.mutate((s) => void (s.sessions.find((x) => x.hash === sha256(sid))!.authAt = Date.now()));

  // Removing: its key gone, the uses on its models back to the defaults.
  assert.equal((await call(`/providers/${id}`, 'DELETE')).status, 200);
  assert.ok(!readFileSync(join(config().dataDir, 'llm-keys.json'), 'utf8').includes(OR_KEY));
  assert.ok(isDefault('writing.translate'));
  assert.equal((await call(`/providers/${id}`, 'DELETE')).status, 404);

  await r.stop();
  assert.ok(!logged.join('').includes(OR_KEY) && !logged.join('').includes(SERVER_KEY) && !logged.join('').includes('sk-redirect'), 'no key in the logs');
});

test('answers: a model list over 2 MB or not JSON fails with a fixed code, nothing of the body in it', async () => {
  resetStore();
  for (const [host, error] of [['big.test', 'models too large'], ['junk.test', 'models bad json']] as const) {
    const r = addProvider({ kind: 'openai', name: host, url: `https://${host}/v1`, key: null });
    assert.ok('id' in r);
    assert.deepEqual([(await testProvider(r.id)).error], [error], host);
  }
  assert.ok(!logged.join('').includes('secret-snippet'), 'nothing of the body logged');
});

test('a provider moved to another host: its key is not kept (asked again when the kind needs one)', () => {
  resetStore();
  const or = addProvider({ kind: 'openrouter', name: 'OR', url: 'https://or.test/api/v1', key: OR_KEY });
  const own = addProvider({ kind: 'openai', name: 'Own', url: 'https://own.test/v1', key: 'sk-own' });
  assert.ok('id' in or && 'id' in own);
  assert.equal(updateProvider(or.id, { url: 'https://or.test/api/v2' }), null, 'same host: kept');
  assert.equal(provider(or.id)!.key(), OR_KEY);
  assert.equal(updateProvider(or.id, { url: 'https://elsewhere.test/api/v1' }), 'key_reentry');
  assert.equal(provider(or.id)!.url, 'https://or.test/api/v2', 'refused: nothing changed');
  assert.equal(updateProvider(or.id, { url: 'https://elsewhere.test/api/v1', key: 'sk-new-key' }), null, 'with a new key: fine');
  assert.equal(updateProvider(own.id, { url: 'https://moved.test/v1' }), null);
  assert.equal(provider(own.id)!.key(), null, 'a key that is optional: dropped');
});

test('store: an unreadable file is set aside, never overwritten; a failed write answers an error and changes nothing', () => {
  const data = config().dataDir;
  writeFileSync(join(data, 'llm.json'), '{ broken');
  resetStore();
  assert.deepEqual(providers().map((p) => p.id), ['env'], 'started empty');
  const aside = readdirSync(data).filter((f) => f.startsWith('llm.json.bad-'));
  assert.equal(aside.length, 1);
  assert.equal(readFileSync(join(data, aside[0]!), 'utf8'), '{ broken', 'kept as it was');
  assert.ok(logged.join('').includes('store unreadable'));
  // The data directory read-only: the change is refused and undone.
  const r = addProvider({ kind: 'openai', name: 'Kept', url: 'https://kept.test/v1', key: null });
  assert.ok('id' in r);
  chmodSync(data, 0o500);
  try {
    assert.deepEqual(addProvider({ kind: 'openai', name: 'Lost', url: 'https://lost.test/v1', key: null }), { error: 'store_failed' });
    assert.equal(setModels(r.id, ['m']), 'store_failed');
  } finally {
    chmodSync(data, 0o700);
  }
  assert.deepEqual(providers().map((p) => p.name), ['9router', 'Kept'], 'what is used is what is on disk');
  assert.deepEqual(provider(r.id)!.models, []);
});

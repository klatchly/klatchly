import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '#core/app.js';
import { sessions, store } from '#core/context.js';
import { Registry } from '#core/registry.js';
import { packages } from '../../packages.server.js';
import type { ChatMessages, LlmProvider } from '../api.js';
import llmServer from '../server/index.js';
import { availableModels, complete, completeFor, defaultRoute, llmLabel, modelStats, resetModelsCache, resetStats, setLlmFetch, validModelId } from '../server/llm.js';
import { providers } from '../server/store.js';

// The llm provider: completions with fallback (on the server's provider), the model list, the package on or off
// with its reason. Providers set in Settings, routing per use and the API: providers.test.ts.

process.env.KLATCHLY_LLM_URL = 'http://llm.test/v1';
process.env.KLATCHLY_LLM_MODEL = 'model-a';
delete process.env.KLATCHLY_LLM_FALLBACK;

const MSG: ChatMessages = [{ role: 'user', content: 'ping' }];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake endpoint: per-model delay and status; records the order of calls and aborts. */
function fake(spec: Record<string, { ms: number; status?: number; content?: string }>) {
  const calls: string[] = [];
  const aborted: string[] = [];
  setLlmFetch(async (_url, init) => {
    const { model } = JSON.parse(String(init?.body)) as { model: string };
    calls.push(model);
    const s = spec[model] ?? { ms: 0, status: 400 };
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, s.ms);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        aborted.push(model);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
    if (s.status && s.status !== 200) return new Response('{}', { status: s.status });
    return Response.json({ choices: [{ message: { content: s.content ?? `from ${model}` } }] });
  }, 'sk-test');
  return { calls, aborted };
}

test('fallback: a quick primary answers alone', async () => {
  resetStats();
  const f = fake({ a: { ms: 5 }, b: { ms: 5 } });
  assert.equal(await complete(MSG, { model: 'a', fallback: 'b' }, { patienceMs: 100 }), 'from a');
  assert.deepEqual(f.calls, ['a']);
  assert.equal(modelStats('a').ok, 1);
});

test('fallback: a slow primary gets the fallback in parallel after the patience; first answer wins, other aborted', async () => {
  resetStats();
  const f = fake({ slow: { ms: 500 }, quick: { ms: 20 } });
  const t0 = Date.now();
  assert.equal(await complete(MSG, { model: 'slow', fallback: 'quick' }, { patienceMs: 50 }), 'from quick');
  const ms = Date.now() - t0;
  assert.ok(ms >= 60 && ms < 400, `answered after patience + fallback (${ms} ms)`);
  assert.deepEqual(f.calls, ['slow', 'quick']);
  await sleep(5);
  assert.deepEqual(f.aborted, ['slow']);
  assert.equal(modelStats('slow').aborted, 1, 'the slow model is marked as dropped');
  assert.equal(modelStats('quick').ok, 1);
});

test('fallback: the primary still wins if it answers before the fallback', async () => {
  const f = fake({ a: { ms: 80 }, b: { ms: 500 } });
  assert.equal(await complete(MSG, { model: 'a', fallback: 'b' }, { patienceMs: 30 }), 'from a');
  await sleep(5);
  assert.deepEqual(f.calls, ['a', 'b']);
  assert.deepEqual(f.aborted, ['b']);
});

test('fallback: an error or empty answer starts the fallback at once', async () => {
  let f = fake({ a: { ms: 5, status: 500 }, b: { ms: 5 } });
  const t0 = Date.now();
  assert.equal(await complete(MSG, { model: 'a', fallback: 'b' }, { patienceMs: 5_000 }), 'from b');
  assert.ok(Date.now() - t0 < 1000, 'no waiting for the patience');
  f = fake({ a: { ms: 5, content: '   ' }, b: { ms: 5 } });
  assert.equal(await complete(MSG, { model: 'a', fallback: 'b' }, { patienceMs: 5_000 }), 'from b');
  assert.deepEqual(f.calls, ['a', 'b']);
});

test('fallback: both fail -> primary error; no fallback -> error as is; cap -> timeout', async () => {
  fake({ a: { ms: 5, status: 502 }, b: { ms: 5, status: 400 } });
  await assert.rejects(complete(MSG, { model: 'a', fallback: 'b' }), /llm 502/);
  await assert.rejects(complete(MSG, { model: 'a', fallback: null }), /llm 502/);
  const f = fake({ a: { ms: 1_000 }, b: { ms: 1_000 } });
  await assert.rejects(complete(MSG, { model: 'a', fallback: 'b' }, { patienceMs: 20, capMs: 80 }), /llm timeout/);
  await sleep(5);
  assert.deepEqual(f.aborted.sort(), ['a', 'b'], 'both calls aborted at the cap');
  // Same model as fallback: a single call.
  const g = fake({ a: { ms: 5, status: 500 } });
  await assert.rejects(complete(MSG, { model: 'a', fallback: 'a' }, { patienceMs: 1 }), /llm 500/);
  assert.deepEqual(g.calls, ['a']);
});

test('models: listed from the endpoint, "-review" variants and odd ids dropped, cached', async () => {
  resetModelsCache();
  let n = 0;
  setLlmFetch(async (url) => {
    n++;
    assert.match(String(url), /\/v1\/models$/);
    return Response.json({ data: [{ id: 'vendor/model-b' }, { id: 'vendor/model-b-review' }, { id: 'vendor/model-a' }, { id: 'bad id' }, { id: 7 }] });
  }, 'sk-test');
  assert.deepEqual(await availableModels(), ['vendor/model-a', 'vendor/model-b']);
  await availableModels();
  assert.equal(n, 1);
  setLlmFetch(async () => new Response('{}', { status: 500 }), 'sk-test');
  assert.deepEqual(await availableModels(true), ['vendor/model-a', 'vendor/model-b'], 'last list kept when the endpoint fails');
  resetModelsCache();
  await assert.rejects(availableModels());
  resetModelsCache();
});

test('one call: model, messages and stream only, to <KLATCHLY_LLM_URL>/chat/completions with the key', async () => {
  let seen: { url: string; auth: string; body: Record<string, unknown>; redirect?: string } | undefined;
  setLlmFetch(async (url, init) => {
    seen = { url: String(url), auth: String((init?.headers as Record<string, string>).authorization), body: JSON.parse(String(init?.body)) as Record<string, unknown>, redirect: init?.redirect };
    return Response.json({ choices: [{ message: { content: '  ok \n' } }] });
  }, 'sk-test');
  assert.equal(await complete(MSG, { model: 'a' }), 'ok', 'trimmed');
  assert.equal(seen!.url, `${process.env.KLATCHLY_LLM_URL}/chat/completions`);
  assert.equal(seen!.auth, 'Bearer sk-test');
  assert.deepEqual(Object.keys(seen!.body).sort(), ['messages', 'model', 'stream'], 'no extra parameter');
  assert.equal(seen!.redirect, 'manual', 'redirects never followed (the key would go along)');
  setLlmFetch(async () => new Response(null, { status: 307, headers: { location: 'http://elsewhere.test/v1/chat/completions' } }), 'sk-test');
  await assert.rejects(complete(MSG, { model: 'a' }), /llm 307/, 'a redirect is an error');
  setLlmFetch(async () => Response.json({}), null);
  await assert.rejects(complete(MSG, { model: 'a' }), /disabled/, 'no key: no call');
});

test('defaults: KLATCHLY_LLM_MODEL, and KLATCHLY_LLM_FALLBACK unless unset or the same model', () => {
  const before = process.env.KLATCHLY_LLM_FALLBACK;
  process.env.KLATCHLY_LLM_FALLBACK = 'model-b';
  assert.deepEqual(defaultRoute(), { model: 'model-a', fallback: 'model-b' });
  process.env.KLATCHLY_LLM_FALLBACK = 'model-a';
  assert.deepEqual(defaultRoute(), { model: 'model-a', fallback: null });
  delete process.env.KLATCHLY_LLM_FALLBACK;
  assert.deepEqual(defaultRoute(), { model: 'model-a', fallback: null });
  if (before !== undefined) process.env.KLATCHLY_LLM_FALLBACK = before;
});

const dir = mkdtempSync(join(tmpdir(), 'klatchly-llm-'));
const KEY_FILE = join(dir, 'llm_key');
writeFileSync(KEY_FILE, 'sk-file\n');
const status = (r: Registry, id: string) => r.describe().packages.find((p) => p.id === id)!;

test('package: on with its endpoint, model and key file; a broken server configuration off with the reason; none: on, no provider', async () => {
  const env = { KLATCHLY_LLM_URL: 'http://llm.test/v1', KLATCHLY_LLM_MODEL: 'model-a', KLATCHLY_LLM_KEY_FILE: KEY_FILE };
  Object.assign(process.env, env);
  setLlmFetch(fetch);
  let r = new Registry(packages);
  assert.deepEqual(status(r, 'llm'), { id: 'llm', active: true, modules: [{ type: 'provider', id: 'llm' }] });
  assert.equal(status(r, 'writing').active, true);

  // No server configuration (1.1): on, with the providers added in Settings (none yet); writing on, its calls fail.
  delete process.env.KLATCHLY_LLM_URL;
  r = new Registry(packages);
  assert.equal(status(r, 'llm').active, true);
  assert.equal(status(r, 'writing').active, true);
  assert.deepEqual(providers(), []);
  await assert.rejects(completeFor('writing.translate', MSG), /disabled/, 'no model at all');

  // A server configuration that names an endpoint must be whole, as before 1.1.
  process.env.KLATCHLY_LLM_URL = env.KLATCHLY_LLM_URL;
  delete process.env.KLATCHLY_LLM_MODEL;
  r = new Registry(packages);
  assert.equal(status(r, 'llm').reason, 'llm: missing config KLATCHLY_LLM_MODEL');
  process.env.KLATCHLY_LLM_MODEL = env.KLATCHLY_LLM_MODEL;
  process.env.KLATCHLY_LLM_KEY_FILE = join(dir, 'missing');
  setLlmFetch(fetch);
  r = new Registry(packages);
  assert.equal(status(r, 'llm').reason, 'llm: key file missing or empty (KLATCHLY_LLM_KEY_FILE)');
  assert.equal(status(r, 'writing').reason, 'requires llm (off)');
  // Off: none of writing's or llm's paths answers, and the app is the core's (no ✨, no translation for the client).
  const sid = store.mutate((s) => sessions.create(s));
  const app = createApp(r);
  for (const p of ['/api/translate', '/api/llm/providers', '/api/llm/routes', '/api/assist/prefs?chatID=x', '/api/translations?chatID=x']) {
    assert.equal((await app.request(p, { headers: { cookie: `sid=${sid}` } })).status, 404, p);
  }
  process.env.KLATCHLY_LLM_URL = 'ftp://llm.test/v1';
  setLlmFetch(fetch);
  r = new Registry(packages);
  assert.equal(status(r, 'llm').reason, 'llm: KLATCHLY_LLM_URL is not an http(s) URL');
  process.env.KLATCHLY_LLM_URL = env.KLATCHLY_LLM_URL;
  process.env.KLATCHLY_LLM_KEY_FILE = KEY_FILE;
  setLlmFetch(fetch, 'sk-test');
});

test('label: KLATCHLY_LLM_LABEL as one name or by language (English required), else null', () => {
  const set = (v: string | undefined) => (v === undefined ? delete process.env.KLATCHLY_LLM_LABEL : (process.env.KLATCHLY_LLM_LABEL = v));
  set(undefined);
  assert.equal(llmLabel(), null);
  set('Model X');
  assert.deepEqual(llmLabel(), { en: 'Model X' });
  set('{"en":"X, through Y","fr":"X, via Y","bad key":"z","de":3}');
  assert.deepEqual(llmLabel(), { en: 'X, through Y', fr: 'X, via Y' });
  for (const bad of ['{"fr":"x"}', '{not json', '{"en":3}']) {
    set(bad);
    assert.equal(llmLabel(), null, bad);
  }
  set(undefined);
  assert.ok(validModelId('vendor/model-a:1') && !validModelId('../x') && !validModelId('a b') && !validModelId(3));
});

test('the provider is the module, with the LlmProvider API of api.ts', () => {
  const p = llmServer.modules[0] as LlmProvider;
  assert.equal(p.type, 'provider');
  assert.deepEqual(p.defaults(), defaultRoute());
  assert.equal(p.complete, complete);
  assert.equal(p.models, availableModels);
  assert.equal(p.label, llmLabel);
  assert.equal(p.validModelId, validModelId);
  assert.ok(p.patienceMs < p.capMs);
});

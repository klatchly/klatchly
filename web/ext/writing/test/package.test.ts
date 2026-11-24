import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '#core/app.js';
import { sessions, store } from '#core/context.js';
import { Registry } from '#core/registry.js';
import { packages } from '../../packages.server.js';
import fr from '../locales/fr.js';
import { launch, llmLabelIn } from '../locales/launch.js';
import { writingModule, writingPackage } from '../package.js';
import writingServer from '../server/index.js';
import { setLlm } from '../server/ai.js';
import { fakeLlm } from './fake.js';

// Writing as a package: on with llm, its API on the paths it had in the core, an on-demand augmentation; its
// catalogs.

const dir = mkdtempSync(join(tmpdir(), 'klatchly-writing-'));
writeFileSync(join(dir, 'llm_key'), 'sk-test\n');
Object.assign(process.env, { KLATCHLY_LLM_URL: 'http://llm.test/v1', KLATCHLY_LLM_MODEL: 'model-a', KLATCHLY_LLM_KEY_FILE: join(dir, 'llm_key') });
after(() => setLlm(undefined));

const sid = store.mutate((s) => sessions.create(s));
const call = (app: ReturnType<typeof createApp>, path: string) => app.request(path, { headers: { cookie: `sid=${sid}` } });

test('on with llm: listed, started with the llm provider, its uses on Default models, its core paths answer', async () => {
  // Writing's choice of models from before llm 1.1 (data/ai.json): handed to llm as each use's legacy route.
  writeFileSync(join(process.env.KLATCHLY_DATA_DIR!, 'ai.json'), JSON.stringify({ translate: { model: 'model-c', fallback: null } }));
  const r = new Registry(packages);
  const app = createApp(r);
  const listed = async () => ((await (await call(app, '/api/extensions')).json()) as { packages: { id: string }[] }).packages.find((p) => p.id === 'writing');
  assert.deepEqual(await listed(), { id: 'writing', active: true, modules: [{ type: 'augmentation', id: 'writing' }] }, 'no label before start, none without KLATCHLY_LLM_LABEL');
  await r.start();
  process.env.KLATCHLY_LLM_LABEL = '{"en":"Model X, through a router","fr":"Modèle X, via un routeur"}';
  assert.deepEqual(await listed(), {
    id: 'writing',
    active: true,
    // Both features on the server's provider: the same name for each.
    modules: [{ type: 'augmentation', id: 'writing', info: { llmLabel: { en: 'Model X, through a router', fr: 'Modèle X, via un routeur' }, llmLabelTranslate: { en: 'Model X, through a router', fr: 'Modèle X, via un routeur' } } }],
  });
  delete process.env.KLATCHLY_LLM_LABEL;
  type Uses = { uses: { id: string; label: Record<string, string>; model: unknown; fallback: unknown; isDefault: boolean }[] };
  const uses = async () => ((await (await call(app, '/api/llm/routes')).json()) as Uses).uses;
  // Writing's uses (other packages of the build list theirs too).
  const u = (await uses()).filter((x) => x.id.startsWith('writing.'));
  assert.deepEqual(u.map((x) => [x.id, x.label.fr]), [['writing.translate', 'Traduction des messages reçus'], ['writing.assist', 'Aide à l’écriture (corrections et traduction du brouillon)'], ['writing.image', 'Traduction des images (un modèle qui lit les images)']]);
  assert.deepEqual([u[0]!.model, u[0]!.fallback, u[0]!.isDefault], [{ provider: 'env', model: 'model-c' }, null, false], 'translate: its earlier choice kept');
  assert.deepEqual([u[1]!.model, u[1]!.isDefault], [{ provider: 'env', model: 'model-a' }, true], 'assist: on the defaults');
  assert.equal((await call(app, '/api/ai/settings')).status, 404, 'its old AI models API is gone (llm has the page)');
  assert.deepEqual(await (await call(app, '/api/translate')).json(), { enabled: true });
  assert.deepEqual(await (await call(app, '/api/assist/prefs?chatID=!p:x')).json(), {});
  assert.deepEqual(await (await call(app, '/api/translations?chatID=!p:x')).json(), { items: {} });
  // Nothing under its own id: the paths did not move.
  assert.equal((await call(app, '/api/writing/assist/prefs?chatID=!p:x')).status, 404);
  await r.stop();
  assert.deepEqual(await uses(), [], 'stopped: its uses leave Default models');
});

test('requires llm; an on-demand augmentation (no event stream)', () => {
  assert.deepEqual(writingPackage.requires, { llm: '^1.2' });
  const m = writingServer.modules[0]!;
  assert.equal(m.type, 'augmentation');
  assert.ok(m.type === 'augmentation' && m.scope === 'on-demand' && !('onEvent' in m && m.onEvent));
  assert.deepEqual(Object.keys(m.mounts ?? {}).sort(), ['assist', 'translate', 'translations']);
  assert.equal(m.routes, undefined);
  // The client half fills the slots of the same module (a launch-path TSX file, read as text).
  const client = readFileSync(new URL('../../../../ext/writing/client/index.tsx', import.meta.url), 'utf8');
  assert.match(client, /augmentation\(\{\s*id: writingModule\.id,/);
  assert.equal(writingModule.id, 'writing');
});

test('catalogs: plurals and interpolation (their shape: ext/build.test.ts)', () => {
  assert.equal(fr.assist.translatedFrom('vietnamien'), 'Traduit en vietnamien · original ci-dessous');
});

test('privacy line: who answers comes from the server (KLATCHLY_LLM_LABEL), per language or one name', () => {
  const info = { llmLabel: { en: 'X, through a router', fr: 'X, via un routeur' } };
  assert.equal(launch.fr!.privacy(llmLabelIn(info, 'fr')), 'Envoyé au modèle IA (X, via un routeur)');
  assert.equal(launch.en!.privacy(llmLabelIn(info, 'de')), 'Sent to the AI model (X, through a router)', 'English fallback');
  assert.equal(launch.en!.privacy(llmLabelIn({ llmLabel: 'Y' }, 'fr')), 'Sent to the AI model (Y)');
  assert.equal(launch.fr!.privacy(llmLabelIn({}, 'fr')), 'Envoyé au modèle IA', 'unset: no name');
});

test("privacy lines: who answers each feature (llm's labelFor), both named when they differ", () => {
  const info = () => writingServer.modules[0]!.info!();
  setLlm(fakeLlm(() => 'ok', undefined, { 'writing.assist': { en: 'Router' }, 'writing.translate': { en: 'OpenRouter' } }).provider);
  assert.deepEqual(info(), { llmLabel: { en: 'Router' }, llmLabelTranslate: { en: 'OpenRouter' } });
  assert.equal(llmLabelIn(info(), 'fr', 'llmLabelTranslate'), 'OpenRouter');
  assert.equal(fr.assist.privacyBoth('Router', 'OpenRouter'), 'Envoyé aux modèles IA : Router (aide à l’écriture), OpenRouter (traduction des messages reçus)');
  setLlm(fakeLlm(() => 'ok').provider);
  assert.deepEqual(info(), {}, 'unnamed: no label');
  setLlm(undefined);
});

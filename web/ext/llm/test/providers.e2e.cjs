// e2e-instance: alone
// Settings → Providers (llm 1.1, /settings/ext/llm/providers), OFFLINE ONLY: it adds, edits and removes providers,
// which applies to the whole server (it runs alone on its instance, offline/run.mjs). The server's provider (the
// fake model of ext/llm/test/offline.mjs) is listed as from the server's configuration; a second one (the fake's OpenRouter-
// like /second/api/v1) is added with its key, tested (the key checked), its models ticked and one added by hand,
// then chosen in Default models and tested there; a wrong key fails its Test; a provider that redirects fails
// without following; the key never comes back (page, API); removing it puts the use back on the defaults. At phone
// width: no horizontal scroll, buttons at least 36 px high.
// sh web/test/e2e/run-offline.sh ../../ext/llm/test/providers.e2e.cjs
const { BASE, check, open, enroll, logout, settingsPage, shot, done } = require('../../../test/e2e/lib');

if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error(`refusing to change the LLM providers of ${BASE}: offline instances only`);
  process.exit(2);
}

const SECOND_KEY = 'offline-second-key-0123';
const providersApi = (page) => page.evaluate(async () => (await fetch('/api/llm/providers')).text());

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  page.on('dialog', (d) => d.accept());
  try {
    await enroll(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await settingsPage(page, 'llm-providers');
    check(new URL(page.url()).pathname === '/settings/ext/llm/providers', "its page in llm's namespace");
    await page.waitForSelector('[data-testid=llm-provider-env]');
    check(!(await page.isVisible('[data-testid=llm-stepup]')), 'just signed in: no confirmation asked');
    const env = await page.textContent('[data-testid=llm-provider-env]');
    check(/configuration du serveur/.test(env) && /Clé enregistrée/.test(env), `the server's provider: from its configuration, its key set (${env.slice(0, 80)}…)`);
    check(!(await page.isVisible('[data-testid=llm-provider-env-remove]')), 'it cannot be removed');
    const envUrl = JSON.parse(await providersApi(page)).providers[0].url;
    await page.click('[data-testid=llm-provider-env-test]');
    await page.waitForSelector('[data-testid=llm-provider-env-result]', { timeout: 15000 });
    check(/joint · 3 modèles/.test(await page.textContent('[data-testid=llm-provider-env-result]')), 'Test: the server provider reached, its 3 chat models');

    // Add the second provider, OpenRouter-like, with its key.
    await page.click('[data-testid=llm-add]');
    await page.selectOption('[data-testid=llm-new-kind]', 'openrouter');
    check((await page.inputValue('[data-testid=llm-new-url]')) === 'https://openrouter.ai/api/v1', "the kind's usual address filled in");
    check((await page.inputValue('[data-testid=llm-new-name]')) === 'OpenRouter', "and its name");
    await page.fill('[data-testid=llm-new-name]', 'Second');
    await page.fill('[data-testid=llm-new-url]', envUrl.replace(/\/v1$/, '/second/api/v1'));
    check((await page.getAttribute('[data-testid=llm-new-key]', 'type')) === 'password', 'the key typed in a password field');
    await page.fill('[data-testid=llm-new-key]', SECOND_KEY);
    await page.click('[data-testid=llm-new-save]');
    await page.waitForSelector('[data-testid=llm-new]', { state: 'detached', timeout: 10000 });
    const list = JSON.parse(await providersApi(page)).providers;
    const id = list.find((p) => p.name === 'Second')?.id;
    check(!!id && list.length === 2, `added (${id})`);
    const tid = `llm-provider-${id}`;
    await page.waitForSelector(`[data-testid=${tid}]`);
    check(!(await page.content()).includes(SECOND_KEY) && !(await providersApi(page)).includes(SECOND_KEY), 'the key never comes back (page, API)');
    check(/Clé enregistrée/.test(await page.textContent(`[data-testid=${tid}-key]`)), '"key set"');

    // Test: reached, and the key checked.
    await page.click(`[data-testid=${tid}-test]`);
    await page.waitForSelector(`[data-testid=${tid}-result]`, { timeout: 15000 });
    const tested = await page.textContent(`[data-testid=${tid}-result]`);
    check(/joint · 2 modèles/.test(tested) && /clé acceptée/.test(tested), `Test: its 2 chat models, key accepted (${tested})`);

    // Its models: tick one, add one by hand.
    await page.click(`[data-testid=${tid}-models]`);
    await page.waitForSelector(`[data-testid=${tid}-list]`);
    const ids = await page.$$eval(`[data-testid=${tid}-list] input`, (i) => i.map((x) => x.dataset.testid));
    check(ids.length === 2 && !ids.some((x) => x.endsWith('second/paint')), `listed: its chat models only (${ids.length})`);
    await page.check(`[data-testid="${tid}-model-second/alpha-1"]`);
    await page.fill(`[data-testid=${tid}-manual]`, 'second/gamma-3');
    await page.click(`[data-testid=${tid}-manual-add]`);
    await page.waitForSelector(`[data-testid="${tid}-model-second/gamma-3"]`);
    check(/2 sur 3 activés/.test(await page.textContent(`[data-testid=${tid}-count]`)), 'count: 2 of 3 enabled');
    check(/ajouté à la main/.test(await page.textContent(`[data-testid=${tid}-list]`)), 'the one added by hand says so');
    const noHScroll = () => page.evaluate(() => {
      const d = document.querySelector('[data-testid=settings]');
      return d.scrollWidth <= d.clientWidth + 1;
    });
    check(await noHScroll(), 'phone: no horizontal scroll');
    const small = await page.$$eval('[data-testid=llm-providers] .llm-btn', (b) => b.filter((x) => x.getBoundingClientRect().height < 36).length);
    check(small === 0, 'phone: every button at least 36 px high');
    await shot(page, 'llm-providers');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'llm-providers-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    // A wrong key: Test fails on it; the right one again.
    await page.click(`[data-testid=${tid}-edit]`);
    check(/Clé enregistrée/.test(await page.textContent(`[data-testid=llm-edit-${id}-key-state]`)), 'edit: the key shown as set, never its value');
    await page.click(`[data-testid=llm-edit-${id}-key-replace]`);
    await page.fill(`[data-testid=llm-edit-${id}-key]`, 'wrong-key-000');
    await page.click(`[data-testid=llm-edit-${id}-save]`);
    await page.waitForSelector(`[data-testid=llm-edit-${id}]`, { state: 'detached' });
    await page.click(`[data-testid=${tid}-test]`);
    for (const t0 = Date.now(); Date.now() - t0 < 15000; await page.waitForTimeout(100)) if (/échec/.test((await page.textContent(`[data-testid=${tid}-result]`).catch(() => '')) ?? '')) break;
    check(/échec \(key 401\)/.test(await page.textContent(`[data-testid=${tid}-result]`)), 'a wrong key: Test fails on the key');
    await page.click(`[data-testid=${tid}-edit]`);
    await page.click(`[data-testid=llm-edit-${id}-key-replace]`);
    await page.fill(`[data-testid=llm-edit-${id}-key]`, SECOND_KEY);
    await page.click(`[data-testid=llm-edit-${id}-save]`);
    await page.waitForSelector(`[data-testid=llm-edit-${id}]`, { state: 'detached' });

    // A provider that redirects: its Test fails, nothing followed.
    await page.click('[data-testid=llm-add]');
    await page.fill('[data-testid=llm-new-name]', 'Redirects');
    await page.fill('[data-testid=llm-new-url]', envUrl.replace(/\/v1$/, '/redirect/v1'));
    await page.click('[data-testid=llm-new-save]');
    await page.waitForSelector('[data-testid=llm-new]', { state: 'detached', timeout: 10000 });
    const red = JSON.parse(await providersApi(page)).providers.find((p) => p.name === 'Redirects').id;
    await page.click(`[data-testid=llm-provider-${red}-test]`);
    await page.waitForSelector(`[data-testid=llm-provider-${red}-result]`, { timeout: 15000 });
    check(/échec \(models 302\)/.test(await page.textContent(`[data-testid=llm-provider-${red}-result]`)), 'a redirect is a failure, not followed');
    await page.click(`[data-testid=llm-provider-${red}-remove]`);
    await page.waitForSelector(`[data-testid=llm-provider-${red}]`, { state: 'detached' });

    // Default models: its model chosen for translation, "model · provider", and tested.
    await settingsPage(page, 'llm-models');
    await page.waitForSelector('[data-testid=llm-writing-translate-model]');
    await page.selectOption('[data-testid=llm-writing-translate-model]', `${id}|second/alpha-1`);
    await page.waitForSelector('[data-testid=llm-routes-note]');
    check((await page.inputValue('[data-testid=llm-writing-translate-model]')) === `${id}|second/alpha-1`, 'translation on the second provider');
    const label = await page.$eval('[data-testid=llm-writing-translate-model] option:checked', (o) => o.textContent);
    check(/^second\/alpha-1 · Second · /.test(label), `"model · provider" (${label})`);
    await page.click('[data-testid=llm-writing-translate-model-test]');
    await page.waitForSelector('[data-testid=llm-writing-translate-model-result]', { timeout: 30000 });
    check(/réponse en/.test(await page.textContent('[data-testid=llm-writing-translate-model-result]')), 'Test: its model answers');

    // Removing it: the use goes back to the defaults.
    await settingsPage(page, 'llm-providers');
    await page.waitForSelector(`[data-testid=${tid}-remove]`);
    await page.click(`[data-testid=${tid}-remove]`);
    await page.waitForSelector(`[data-testid=${tid}]`, { state: 'detached' });
    const uses = await page.evaluate(async () => (await (await fetch('/api/llm/routes')).json()).uses);
    check(uses.every((u) => u.isDefault && u.model.provider === 'env'), 'removed: its use back on the defaults');
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
    await logout(page);
    await s.browser.close();
    done(s.csp);
  }
})();

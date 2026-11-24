// Settings → Default models (llm 1.1, /settings/ext/llm/models, under « Modèles de langage » in the menu; writing's
// Modèles IA page before it): model and fallback per use (writing's two), "model · provider" with latency hints, Test
// button (fixed prompt, no user data). Read-only: the settings are never changed.
// sh web/test/e2e/run-offline.sh ../../ext/llm/test/routes.e2e.cjs
const { check, open, enroll, logout, settingsPage, shot, done } = require('../../../test/e2e/lib');

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  try {
    await enroll(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await settingsPage(page, 'llm-models');
    check(new URL(page.url()).pathname === '/settings/ext/llm/models', "its page in llm's namespace");
    await page.waitForSelector('[data-testid=llm-routes] select');
    const text = await page.textContent('[data-testid=llm-routes]');
    check(/Traduction des messages reçus/.test(text) && /Aide à l’écriture/.test(text), "writing's two uses listed (French, from writing)");
    // The models the server's provider offers (GET /api/llm/routes): each select picks among them.
    const offered = await page.evaluate(async () => (await (await fetch('/api/llm/routes')).json()).choices.items.filter((m) => m.enabled).map((m) => `${m.provider}|${m.model}`));
    for (const f of ['translate', 'assist']) {
      const model = await page.inputValue(`[data-testid=llm-writing-${f}-model]`);
      const fb = await page.inputValue(`[data-testid=llm-writing-${f}-fallback]`);
      console.log(`  ${f}: ${model} -> ${fb}`);
      check(offered.includes(model) && model.startsWith('env|'), `${f}: a model of the server's provider is selected (${model})`);
      check(fb === 'none' || (offered.includes(fb) && fb !== model), `${f}: fallback is another model or none (${fb})`);
    }
    const opts = await page.$$eval('[data-testid=llm-writing-translate-model] option', (o) => o.map((x) => x.value));
    check(opts.length > 1 && !opts.some((v) => v.endsWith('-review')), `models offered without -review variants (${opts.length})`);
    const label = await page.$eval('[data-testid=llm-writing-translate-model] option:checked', (o) => o.textContent);
    check(/^fake\/swift-1 · 127\.0\.0\.1 \(par défaut\) · /.test(label), `an option reads "model · provider" (${label})`);
    // Two rows (model, fallback) per use the packages on declare (writing: 3, ask: 1 since 0.21.0).
    const uses = (await page.$$('[data-testid=llm-routes] fieldset.llm-group')).length;
    check(uses > 0 && (await page.$$('[data-testid=llm-routes] .set-row')).length === 2 * uses, `a row per use and slot (${uses} uses)`);
    const sel = await page.locator('[data-testid=llm-writing-translate-model]').boundingBox();
    check(!!sel && sel.width >= 300, `phone: the model select on the full width (${Math.round(sel?.width ?? 0)} px)`);
    const noHScroll = await page.evaluate(() => {
      const d = document.querySelector('[data-testid=settings]');
      return d.scrollWidth <= d.clientWidth + 1;
    });
    check(noHScroll, 'no horizontal scroll at phone width');
    await page.click('[data-testid=llm-writing-translate-fallback-test]');
    await page.waitForSelector('[data-testid=llm-writing-translate-fallback-result]', { timeout: 50000 });
    const res = await page.textContent('[data-testid=llm-writing-translate-fallback-result]');
    console.log('  test result:', res);
    check(/réponse en/.test(res), 'Test on the fallback model answers with a time');
    await page.$eval('[data-testid=llm-routes]', (el) => el.scrollIntoView());
    await shot(page, 'llm-routes');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'llm-routes-dark');
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

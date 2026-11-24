// e2e-instance: alone
// Sign-in, passkeys only: Settings → Général → Connexion (Manage…) lists the passkeys (rename; add one on this device,
// refused while the authenticator already holds one, made once it does not, then removed; the last one cannot be
// removed) and the connected devices (a second browser signed in with the same passkey is listed, signed out from
// here, its page back on the key button; then "all the other devices"); when the confirmation window is over, the
// step-up box confirms with the passkey (a real step-up, the server checks it), for the sign-in settings and for an
// extension switch; signed out, the key button signs back in. Changes the instance's sessions: offline only, on an
// instance of its own (first line). Never against production.
// sh web/test/e2e/run-offline.sh auth.e2e.js
const { BASE, check, open, enroll, login, logout, settingsPage, shot, done } = require('./lib');

if (!/^http:\/\/localhost:/.test(BASE)) throw new Error('auth.e2e.js changes the instance’s sessions: offline instances only');

const devices = (page) => page.$$('[data-testid=signin-device]');
/** Waits for a condition checked from here (the page's CSP refuses Playwright's in-page polling). */
async function until(cond, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((ok) => setTimeout(ok, 100))) if (await cond()) return true;
  throw new Error('timed out');
}
const deviceCount = (page, n) => until(async () => (await devices(page)).length === n);

(async () => {
  const { browser, page, csp, cdp, authenticatorId } = await open();
  await enroll(page);
  await settingsPage(page, 'general');
  await page.waitForSelector('[data-testid=settings-signin] [data-testid=signin-state]', { timeout: 15000 });
  check((await page.getAttribute('[data-testid=signin-state]', 'data-mode')) === 'passkey', 'passkeys only');
  check(/1 passkey · 1 device/.test(await page.textContent('[data-testid=signin-state]')), 'the row: one passkey, one device');
  check(!(await page.$('[data-testid=signin-passkeys]')), 'closed: the summary only');

  // Manage…: just signed in, no confirmation; the passkey and this device.
  await page.click('[data-testid=signin-change]');
  await page.waitForSelector('[data-testid=signin-passkeys]', { timeout: 5000 });
  check(!(await page.isVisible('[data-testid=signin-stepup]')), 'just signed in: no confirmation asked');
  check((await page.$$('[data-testid=signin-passkey]')).length === 1, 'one passkey listed');
  check(await page.isDisabled('[data-testid=signin-passkey-remove]'), 'the last passkey cannot be removed');
  check((await devices(page)).length === 1 && !!(await page.$('[data-testid=signin-device][data-current="1"]')), 'this device listed, marked');
  check(/Chrome/.test(await page.textContent('[data-testid=signin-device]')), 'the device named from its browser');

  // Rename.
  await page.click('[data-testid=signin-passkey-rename]');
  await page.fill('[data-testid=signin-passkey-name]', 'Work laptop');
  await page.click('[data-testid=signin-passkey-save]');
  await until(async () => (await page.textContent('[data-testid=signin-passkey-label]')) === 'Work laptop');
  check(true, 'passkey renamed');
  await shot(page, 'auth-settings');

  // Add a passkey on this device (signed in, no enrollment code). This authenticator already holds the first one, which
  // the server excludes: the browser refuses to make a second, the line says so.
  await page.click('[data-testid=signin-passkey-add]');
  check((await page.inputValue('[data-testid=signin-passkey-new-name]')) === 'Linux', 'the new passkey named after this system');
  await page.click('[data-testid=signin-passkey-create]');
  await page.waitForSelector('#signin-detail [data-testid=settings-note]', { timeout: 10000 });
  check(/already holds a passkey/.test(await page.textContent('#signin-detail [data-testid=settings-note]')), 'excluded: this device already holds one');
  // Without it (another authenticator, say a security key): the passkey is made, named, listed.
  const { credentials: first } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  for (const credential of first) await cdp.send('WebAuthn.removeCredential', { authenticatorId, credentialId: credential.credentialId });
  await page.fill('[data-testid=signin-passkey-new-name]', 'Security key');
  const added = page.waitForResponse((r) => r.url().endsWith('/api/auth/passkeys') && r.request().method() === 'POST');
  await page.click('[data-testid=signin-passkey-create]');
  check((await added).status() === 200, 'the new passkey accepted by the server');
  await until(async () => (await page.$$('[data-testid=signin-passkey]')).length === 2);
  check((await page.$$eval('[data-testid=signin-passkey-label]', (els) => els.map((e) => e.textContent))).join() === 'Work laptop,Security key', 'listed with its name');
  check(!(await page.$('[data-testid=signin-passkey-new]')), 'the form closed');
  // Removed again (from the list and from the authenticator), the first one back in it.
  const { credentials: both } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  const made = both.find((x) => !first.some((f) => f.credentialId === x.credentialId));
  await page.click('[data-testid=signin-passkey]:nth-child(2) [data-testid=signin-passkey-remove]');
  await page.click('[data-testid=signin-ask-ok]');
  await until(async () => (await page.$$('[data-testid=signin-passkey]')).length === 1);
  check(true, 'the added passkey removed');
  if (made) await cdp.send('WebAuthn.removeCredential', { authenticatorId, credentialId: made.credentialId });
  for (const credential of first) await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });

  // A second browser with the same passkey (synced, as a phone would have it): its own session.
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  const other = await open({ browser });
  await other.ctx.clearCookies();
  for (const credential of credentials) await other.cdp.send('WebAuthn.addCredential', { authenticatorId: other.authenticatorId, credential }).catch(() => {});
  await login(other.page);
  await page.click('[data-testid=signin-change]');
  await page.reload();
  await page.click('[data-testid=settings-signin] [data-testid=signin-change]', { timeout: 15000 });
  await page.waitForSelector('[data-testid=signin-devices]', { timeout: 5000 });
  check((await devices(page)).length === 2, 'the second browser is listed');
  await page.click('[data-testid=signin-device-signout]');
  await page.click('[data-testid=signin-ask-ok]');
  await deviceCount(page, 1);
  check(true, 'the other device signed out from here');
  // Its socket is closed by the server: that page goes back to the key button by itself.
  check(await other.page.waitForSelector('[data-testid=unlock]', { timeout: 40000 }).then(() => true, () => false), 'the signed-out browser is back on the key button');

  // Back in on the second browser; then "all the other devices", behind a real step-up: the window faked over once.
  await login(other.page);
  // Two virtual authenticators with one credential count its uses apart (a synced passkey would not count): this one
  // takes the other's count, else the server sees the counter go back (a cloned key) and refuses.
  const { credentials: used } = await other.cdp.send('WebAuthn.getCredentials', { authenticatorId: other.authenticatorId });
  for (const credential of used) {
    await cdp.send('WebAuthn.removeCredential', { authenticatorId, credentialId: credential.credentialId }).catch(() => {});
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
  }
  let faked = 0;
  await page.route('**/api/auth/settings', async (r) => {
    const res = await r.fetch();
    const body = await res.json();
    await r.fulfill({ response: res, json: faked++ === 0 ? { ...body, stepUp: { leftMs: 0, methods: ['passkey'] } } : body });
  });
  await page.reload();
  await page.click('[data-testid=settings-signin] [data-testid=signin-change]', { timeout: 15000 });
  await page.waitForSelector('[data-testid=signin-stepup]', { timeout: 5000 });
  check(!(await page.$('[data-testid=signin-passkeys]')), 'window over: confirm first, the lists hidden');
  await shot(page, 'auth-stepup');
  const stepUp = page.waitForResponse((r) => r.url().endsWith('/api/auth/stepup/passkey'));
  await page.click('[data-testid=signin-stepup-passkey]');
  check((await stepUp).status() === 200, 'step-up with the passkey accepted by the server');
  await page.waitForSelector('[data-testid=signin-devices]', { timeout: 10000 });
  await page.unroute('**/api/auth/settings');
  await deviceCount(page, 2).catch(() => {});
  await page.click('[data-testid=signin-signout-others]');
  await page.click('[data-testid=signin-ask-ok]');
  await deviceCount(page, 1);
  check(!(await page.$('[data-testid=signin-signout-others]')), 'all the other devices signed out');
  check(await other.page.waitForSelector('[data-testid=unlock]', { timeout: 40000 }).then(() => true, () => false), 'and that browser is back on the key button');
  await other.ctx.close();

  // An extension switch refused for want of a recent confirmation: the step-up box, then the switch goes through.
  await settingsPage(page, 'extensions');
  await page.waitForSelector('[data-testid=ext-toggle-writing]', { timeout: 15000 });
  let refused = 0;
  await page.route('**/api/extensions/writing', (r) => (r.request().method() === 'PUT' && refused++ === 0 ? r.fulfill({ status: 403, json: { error: 'step_up' } }) : r.continue()));
  await page.route('**/api/auth/stepup', async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, json: refused === 1 ? { leftMs: 0, methods: ['passkey'] } : await res.json() });
  });
  await page.click('[data-testid=ext-toggle-writing]');
  await page.waitForSelector('[data-testid=ext-stepup]', { timeout: 10000 });
  check(true, 'extension switch: the step-up box');
  const put = page.waitForResponse((r) => r.url().endsWith('/api/extensions/writing') && r.request().method() === 'PUT' && r.status() === 200);
  refused = 2;
  await page.click('[data-testid=ext-stepup-passkey]');
  check(await put.then(() => true, () => false), 'confirmed: the switch goes through');
  await page.waitForSelector('[data-testid=ext-stepup]', { state: 'detached', timeout: 10000 });
  await page.unroute('**/api/extensions/writing');
  await page.unroute('**/api/auth/stepup');
  // Back on (the other scripts of this instance: none, but leave it as found).
  const back = page.waitForResponse((r) => r.url().endsWith('/api/extensions/writing') && r.request().method() === 'PUT');
  await page.click('[data-testid=ext-toggle-writing]');
  if (await page.isVisible('[data-testid=ext-confirm-writing]')) await page.click('[data-testid=ext-confirm-writing] [data-testid=ext-confirm-ok]');
  await back;

  // Signed out (the request lost twice on the way: the app tries again), then back in with the key button.
  let tries = 0;
  await page.route('**/api/auth/logout', (r) => (++tries <= 2 ? r.abort('internetdisconnected') : r.continue()));
  await logout(page);
  await page.waitForSelector('[data-testid=unlock]', { timeout: 15000 });
  await page.unroute('**/api/auth/logout');
  check(tries === 3, `sign-out tried again after a lost request (${tries} tries)`);
  check(!(await page.$('input[type=password]')), 'no password field on the sign-in page');
  await page.click('[data-testid=unlock]');
  check(await page.waitForSelector('[data-testid=chat-row]', { timeout: 30000 }).then(() => true, () => false), 'signed in with the passkey');

  await browser.close();
  done(csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

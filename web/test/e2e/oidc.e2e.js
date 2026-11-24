// e2e-instance: alone R_OIDC=1
// Sign-in through an OIDC provider, against the fake one of the offline instance (offline/oidc.mjs, on 127.0.0.1:
// another site than the app's localhost, as a real provider): with no passkey yet the sign-in page shows only
// "Continue with Fake ID"; an account not linked is refused with a clear page; /enroll links the owner's account with
// the code, and the provider's cross-site return lands signed in with no reload by hand (the Strict session cookie set
// on the return page, sent by its same-site navigation); Settings → Connexion shows the provider and the linked
// subject; signed out, "Continue with" signs back in, someone else at the provider is refused; the step-up box
// confirms at the provider (prompt=login) and comes back to Settings. Offline only, on an instance of its own
// (its own instance, R_OIDC=1: first line). Never against production.
// sh web/test/e2e/run-offline.sh oidc.e2e.js
const { BASE, check, open, logout, settingsPage, shot, done } = require('./lib');

if (!/^http:\/\/localhost:/.test(BASE)) throw new Error('oidc.e2e.js links an account: offline instances only');

/** At the fake provider: sign in as `who` ('owner' or 'stranger'); back on the app's origin. */
async function atProvider(page, who) {
  await page.waitForSelector(`[data-testid=idp-${who}]`, { timeout: 15000 });
  check(page.url().startsWith('http://127.0.0.1:'), `at the provider (${who})`);
  await page.click(`[data-testid=idp-${who}]`);
}

const signedIn = (page) => page.waitForSelector('[data-testid=chat-row]', { timeout: 30000 }).then(() => true, () => false);
const refused = async (page, error) => {
  await page.waitForSelector('[data-testid=oidc-error]', { timeout: 15000 });
  return (await page.getAttribute('[data-testid=oidc-error]', 'data-error')) === error;
};

(async () => {
  const { page, csp } = await open();

  // The sign-in page: no passkey yet, the provider only.
  await page.goto(`${BASE}/`);
  await page.waitForSelector('[data-testid=oidc-continue]', { timeout: 30000 });
  check(/Continue with Fake ID/.test(await page.textContent('[data-testid=oidc-continue]')), '"Continue with Fake ID"');
  check(!(await page.$('[data-testid=unlock]')), 'no passkey yet: no key button');
  await shot(page, 'oidc-signin');

  // Nobody linked yet: refused, with the way to link.
  await page.click('[data-testid=oidc-continue]');
  await atProvider(page, 'owner');
  check(await refused(page, 'not_allowed'), 'not linked: refused with a clear page');
  check(/enrollment code/.test(await page.textContent('[data-testid=oidc-error]')), 'the page says how to link');
  await shot(page, 'oidc-refused');

  // Linking on /enroll with the code: back signed in, without reloading by hand (the cross-site return).
  await page.goto(`${BASE}/enroll`);
  await page.fill('[data-testid=enroll-code]', process.env.CODE);
  await page.click('[data-testid=oidc-link]');
  await atProvider(page, 'owner');
  check(await signedIn(page), 'linked: signed in after the provider’s return');
  check(new URL(page.url()).pathname === '/', 'on the app’s home');

  // Settings → Connexion: the provider and the linked subject.
  await settingsPage(page, 'general');
  await page.waitForSelector('[data-testid=settings-signin] [data-testid=signin-state]', { timeout: 15000 });
  check(/Passkeys and Fake ID/.test(await page.textContent('[data-testid=settings-signin]')), 'the row names both ways in');
  await page.click('[data-testid=signin-change]');
  await page.waitForSelector('[data-testid=signin-oidc-linked]', { timeout: 5000 });
  check(/subject owner/.test(await page.textContent('[data-testid=signin-oidc-linked]')), 'the linked subject shown');
  check(/127\.0\.0\.1/.test(await page.textContent('[data-testid=signin-oidc-issuer]')), 'the issuer shown');
  check(await page.isDisabled('[data-testid=signin-oidc-unlink]'), 'Unlink disabled: no passkey, it is the only way in');
  check(/via Fake ID/.test(await page.textContent('[data-testid=signin-device][data-current="1"]')), 'this device signed in via the provider');
  await shot(page, 'oidc-settings');

  // Step-up at the provider: the window faked over once (as auth.e2e.js), a real round trip with prompt=login.
  let faked = 0;
  await page.route('**/api/auth/settings', async (r) => {
    const res = await r.fetch();
    const body = await res.json();
    await r.fulfill({ response: res, json: faked++ === 0 ? { ...body, stepUp: { leftMs: 0, methods: [], oidc: 'Fake ID' } } : body });
  });
  await page.reload();
  await page.click('[data-testid=settings-signin] [data-testid=signin-change]', { timeout: 15000 });
  await page.waitForSelector('[data-testid=signin-stepup-oidc]', { timeout: 5000 });
  check(/Confirm with Fake ID/.test(await page.textContent('[data-testid=signin-stepup-oidc]')), 'the step-up box offers the provider');
  await page.click('[data-testid=signin-stepup-oidc]');
  await page.waitForSelector('[data-testid=idp-prompt]', { timeout: 15000 });
  check((await page.textContent('[data-testid=idp-prompt]')) === 'login', 'a fresh sign-in asked (prompt=login)');
  await atProvider(page, 'owner');
  await page.waitForSelector('[data-testid=settings-signin]', { timeout: 30000 });
  check(new URL(page.url()).pathname === '/settings/general', 'back on Settings after the confirmation');
  await page.unroute('**/api/auth/settings');

  // Signed out: "Continue with" signs back in; someone else at the provider does not.
  await logout(page);
  await page.waitForSelector('[data-testid=oidc-continue]', { timeout: 15000 });
  await page.click('[data-testid=oidc-continue]');
  await atProvider(page, 'owner');
  check(await signedIn(page), 'signed back in with the provider');
  await logout(page);
  await page.waitForSelector('[data-testid=oidc-continue]', { timeout: 15000 });
  await page.click('[data-testid=oidc-continue]');
  await atProvider(page, 'stranger');
  check(await refused(page, 'not_allowed'), 'someone else at the provider: refused');
  await page.click('a');
  await page.waitForSelector('[data-testid=oidc-continue]', { timeout: 15000 });
  check(true, 'the refusal page leads back to the sign-in page');

  done(csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

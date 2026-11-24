// Shared helpers for the E2E scripts. No secrets here: the enrollment code comes from $CODE.
const { readFileSync, writeFileSync } = require('fs');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:3095';
const SHOTS = process.env.SHOTS || '/shots';
// One passkey for a whole batch of scripts (production: enrollment is limited to 10 per 10 min). The first script
// enrolls with $CODE and writes the session here (the cookies, and the virtual authenticator's credential); the
// next ones open signed in, or unlock with that credential, without a code. A throwaway test passkey: delete the
// file afterwards and remove the passkey (cli.js passkeys remove).
const SESSION_FILE = process.env.SESSION_FILE || '';
const savedSession = () => {
  if (!SESSION_FILE) return null;
  try {
    return JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
};
// Each page's virtual authenticator (open), for the session file.
const authenticators = new WeakMap();
// Test chat (the offline instance's, offline/beeper.mjs): the only chat where anything is sent.
const TEST_CHAT = process.env.TEST_CHAT || '!test:beeper.local';

// Agent drafts (chatagent) the script read from the test chat: the only ones it may send or drop.
const agentDrafts = new Set();
const allowDraft = (id) => agentDrafts.add(id);

/** A forward request whose every source and target is the test chat. */
function forwardIsTest(body) {
  try {
    const b = JSON.parse(body);
    return Array.isArray(b.to) && b.to.length > 0 && b.to.every((t) => t === TEST_CHAT) && Array.isArray(b.from) && b.from.every((f) => f && f.chatID === TEST_CHAT);
  } catch {
    return false;
  }
}

let failures = 0;
/** A step reached (the wait before it throws otherwise): logged, not counted as a check. */
function step(label) {
  console.log(`  -> ${label}`);
}

function check(cond, label) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
}

/** New context with a CDP virtual authenticator; collects CSP violations from every page. */
async function open({ locale = 'en-US', browser, permissions = [] } = {}) {
  // channel 'chromium' = full Chromium in new headless mode (the default headless shell denies notifications).
  browser ??= await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chromium', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const saved = savedSession();
  // The session only: the UI language another script chose (localStorage 'lang') would override `locale`.
  const storageState = saved && { ...saved.storageState, origins: (saved.storageState.origins ?? []).map((o) => ({ ...o, localStorage: (o.localStorage ?? []).filter((e) => e.name !== 'lang') })) };
  const ctx = await browser.newContext({ locale, viewport: { width: 1200, height: 800 }, ...(storageState ? { storageState } : {}) });
  if (permissions.length) await ctx.grantPermissions(permissions, { origin: BASE });
  // Safety net: no write may reach a real chat (mark-read on open included); only the test chat.
  const blocked = [];
  await ctx.route('**/api/**', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    let body = '';
    try {
      body = req.postData() || '';
    } catch {}
    // /api/chats itself (POST = create a chat) and /api/chats/start included: those only run against mocks.
    // Agents inside chats (0.13): settings, "ask", drafts. A draft is addressed by its id only: allowed when the
    // script read it from the test chat (allowDraft).
    const draft = /^\/api\/chatagent\/drafts\/([0-9a-f]{16})(\/send)?$/.exec(url.pathname);
    const touchesChat =
      url.pathname === '/api/chats' ||
      url.pathname.startsWith('/api/chats/') ||
      url.pathname.startsWith('/api/notify/') ||
      // Agents 2.0: the Settings page of its llm agents (/api/chatagent/llm-agents) reaches no chat.
      (url.pathname.startsWith('/api/chatagent/') && !url.pathname.startsWith('/api/chatagent/llm-agents')) ||
      // Ask (0.21): a new question reads a chat's messages and sends them to the model.
      url.pathname === '/api/ask/threads';
    const isTest = url.pathname.includes(encodeURIComponent(TEST_CHAT)) || url.search.includes(encodeURIComponent(TEST_CHAT)) || body.includes(TEST_CHAT) || (!!draft && agentDrafts.has(draft[1]));
    // 0.14.21: forwarding sends real messages: only from and into the test chat. "Mark all low-priority chats as
    // read" acts on real chats: never for real (tests stub it with page.route, which takes precedence).
    if (req.method() !== 'GET' && url.pathname === '/api/forward' && !forwardIsTest(body)) {
      blocked.push('POST /api/forward (not the test chat)');
      return route.abort();
    }
    if (req.method() !== 'GET' && url.pathname.startsWith('/api/inbox/')) {
      blocked.push(`${req.method()} ${url.pathname}`);
      return route.abort();
    }
    if (req.method() !== 'GET' && touchesChat && !isTest) {
      blocked.push(`${req.method()} ${url.pathname.replace(/\/chats\/([^/]{0,6})[^/]*/, '/chats/$1…')}`);
      return route.abort();
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  const csp = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text());
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.log(`Refused to (CSP) ${e.violatedDirective} ${e.blockedURI}`));
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  for (const credential of saved?.credentials ?? []) await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
  authenticators.set(page, { cdp, authenticatorId });
  return { browser, ctx, page, csp, cdp, authenticatorId, blocked };
}

/** The session (cookies and the passkey) to SESSION_FILE, for the next script. */
async function saveSession(page) {
  const { cdp, authenticatorId } = authenticators.get(page);
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  writeFileSync(SESSION_FILE, JSON.stringify({ base: BASE, storageState: await page.context().storageState(), credentials }));
}

/**
 * Signs the page in: with the session of SESSION_FILE when there is one (open signed in, or unlock with its
 * passkey), else by enrolling with the code (then the session is saved there for the next script).
 */
async function enroll(page, code = process.env.CODE) {
  const saved = savedSession();
  if (saved?.base === BASE && saved.credentials?.length) {
    await page.goto(`${BASE}/`);
    await page.waitForSelector('[data-testid=chat-row], [data-testid=unlock]', { timeout: 30000 });
    if (await page.isVisible('[data-testid=unlock]')) await page.click('[data-testid=unlock]');
    await page.waitForSelector('[data-testid=chat-row]', { timeout: 30000 });
    await saveSession(page);
    return;
  }
  if (!code) throw new Error('set CODE (cli.js enroll)');
  await page.goto(`${BASE}/enroll`);
  await page.fill('[data-testid=enroll-code]', code);
  await page.click('[data-testid=enroll-submit]');
  await page.waitForSelector('[data-testid=chat-row]', { timeout: 30000 });
  if (SESSION_FILE) await saveSession(page);
}

async function login(page) {
  await page.goto(BASE + '/');
  await page.click('[data-testid=unlock]');
  await page.waitForSelector('[data-testid=chat-row]', { timeout: 30000 });
}

// Settings (0.15.8): three core pages (Général, Application, Extensions) and the packages' pages; 0.15.7's pages are
// blocks of them now (their old ids are the blocks' anchors and test ids).
const SETTINGS_BLOCKS = { language: 'general', notifications: 'general', account: 'general', storage: 'app', about: 'app' };

/**
 * Opens a Settings page from its menu and waits for it: a page's id ('general', 'app', 'extensions', 'llm-models'
 * for a package's) or a block's ('account', 'notifications', 'about'…: the page that holds it).
 */
async function settingsPage(page, id) {
  if (!(await page.isVisible('[data-testid=settings-menu]'))) {
    // The gear is in the list header, hidden under an open chat on a phone: then straight to the menu.
    if (await page.isVisible('[data-testid=open-settings]')) await page.click('[data-testid=open-settings]', { timeout: 5000 });
    else await page.goto(`${BASE}/settings`);
    await page.waitForSelector('[data-testid=settings-menu]', { timeout: 15000 });
  }
  // A page sliding back to the menu (phone) ignores taps on it until it is gone.
  await page.waitForSelector('.shell.swiping', { state: 'detached', timeout: 5000 }).catch(() => {});
  await page.click(`[data-testid=settings-item-${SETTINGS_BLOCKS[id] ?? id}]`, { timeout: 5000 });
  await page.waitForSelector(`.pane-chat [data-testid=settings-${id.replace(/^[a-z0-9]+-/, '')}]`, { timeout: 15000 });
}

/** Out of Settings: a page's Back first where it has one (phone: back to the menu), then the menu's. */
async function leaveSettings(page) {
  if (await page.isVisible('[data-testid=settings-back]')) {
    await page.click('[data-testid=settings-back]');
    await page.waitForSelector('[data-testid=settings-page]', { state: 'hidden', timeout: 10000 });
  }
  await page.click('[data-testid=settings-close]');
  await page.waitForSelector('[data-testid=settings-menu]', { state: 'detached', timeout: 10000 });
}

// Sign-out lives in Settings behind a confirmation (0.10.0); Settings is a page (/settings, 0.14.17), Session a
// block of Général (/settings/general, 0.15.8).
async function logout(page) {
  try {
    await settingsPage(page, 'account');
    await page.click('[data-testid=logout]', { timeout: 5000 });
    await page.click('[data-testid=logout-confirm]', { timeout: 5000 });
  } catch {}
  await page.waitForSelector('[data-testid=unlock]', { timeout: 10000 }).catch(() => {});
}

const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });

function done(csp) {
  if (csp?.length) console.log('CSP:', csp.join('\n'));
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

/**
 * The spaces of the packages that are on (GET /api/extensions), whatever the build, that have a sidebar button
 * (`open-<id>`; a space may have none, only its URLs): [{ id, path, pkg }]. Their list shows in
 * `.pane-list .space-scroll:not(.settings-menu-scroll)`. Looked up on a page of its own, on the chat list.
 */
async function spaces(page) {
  const p = await page.context().newPage();
  try {
    await p.goto(`${BASE}/`);
    await p.waitForSelector('[data-testid=chat-row]', { timeout: 30000 });
    const all = await p.evaluate(async () =>
      (await (await fetch('/api/extensions')).json()).packages.filter((x) => x.active).flatMap((x) => x.modules.filter((m) => m.type === 'space').map((m) => ({ id: m.id, path: m.path, pkg: x.id }))),
    );
    // The buttons come with the packages' client halves, once the server said which are on.
    await p.waitForTimeout(500);
    const out = [];
    for (const sp of all) if (await p.isVisible(`[data-testid=open-${sp.id}]`)) out.push(sp);
    return out;
  } finally {
    await p.close();
  }
}

module.exports = { BASE, SHOTS, TEST_CHAT, check, step, open, enroll, login, logout, settingsPage, leaveSettings, shot, done, allowDraft, spaces };

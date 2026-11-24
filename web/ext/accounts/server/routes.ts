import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { dataPath, fail, log, type Env } from '#core/sdk.js';
import type { AccountReply, AccountsSource, OverviewReply, QrReply } from '../shapes.js';
import { slugAccount } from '../slug.js';
import { capabilitiesOf, parseSince, trackSince, viewsOf, type SinceMap } from './derive.js';

// The space's API, read-only (GET only): /api/networks/overview (the accounts, their health; also the badge),
// /api/networks/stats (figures per account) and /api/networks/account/<slug> (one account: capabilities, recent
// chats). Since when a status holds is Klatchly's own observation, kept in the data volume (accounts.json: account
// ids, statuses, times and source ids, nothing else). Nothing of an account's identity is logged. A source that does
// not answer counts as one more thing to check (the badge), and its accounts' pages say so (503 source_down).

const RECENT = 12;
const FILE = 'accounts.json';

let since: SinceMap | undefined;

function loadSince(): SinceMap {
  try {
    return parseSince(JSON.parse(readFileSync(dataPath(FILE), 'utf8')));
  } catch {
    return {};
  }
}

function saveSince(map: SinceMap): void {
  try {
    const p = dataPath(FILE);
    writeFileSync(`${p}.tmp`, JSON.stringify({ since: map }), { mode: 0o600 });
    renameSync(`${p}.tmp`, p);
  } catch {
    log('accounts', 'save failed');
  }
}

export function resetSinceForTests(): void {
  since = undefined;
}

export function accountsRoutes(source: AccountsSource): Hono<Env> {
  const routes = new Hono<Env>();

  const views = async () => {
    const { accounts: list, sources } = await source.listAccounts();
    const now = Date.now();
    const down = new Set(sources.filter((s) => !s.ok).map((s) => s.id));
    const { next, changed } = trackSince((since ??= loadSince()), list, down, now);
    since = next;
    if (changed) saveSince(next);
    return { list, sources, down, views: viewsOf(list, next, now) };
  };

  routes.get('/overview', async (c) => {
    try {
      const { views: accounts, sources, down } = await views();
      return c.json({ accounts, trouble: accounts.filter((a) => a.health === 'trouble').length + down.size, sources } satisfies OverviewReply);
    } catch (e) {
      return fail(c, e, '/networks/overview');
    }
  });

  routes.get('/stats', async (c) => {
    try {
      return c.json(await source.accountStats());
    } catch (e) {
      return fail(c, e, '/networks/stats');
    }
  });

  routes.get('/account/:slug', async (c) => {
    const id = slugAccount(c.req.param('slug'));
    if (!id) return c.json({ error: 'bad_request' }, 400);
    try {
      const { list, sources, down, views: all } = await views();
      const account = all.find((a) => a.accountID === id);
      if (!account) {
        // Not listed: gone, unless its source (or, when unknown, any source) did not answer.
        const from = since?.[id]?.source;
        if (from ? down.has(from) : down.size > 0) return c.json({ error: 'source_down' }, 503);
        return c.json({ error: 'not_found' }, 404);
      }
      // Figures and recent chats are extras: the page shows without them.
      const [stats, recent] = await Promise.all([
        source.accountStats().then((s) => s.byAccount[id] ?? null, () => null),
        source.recentChats(id, RECENT).catch(() => []),
      ]);
      const capabilities = capabilitiesOf(list.find((a) => a.accountID === id)?.capabilities);
      const from = sources.find((s) => s.id === account.source);
      return c.json({ account, ...(from ? { source: from } : {}), stats, capabilities, recent } satisfies AccountReply);
    } catch (e) {
      return fail(c, e, '/networks/account/:id');
    }
  });

  // A source's sign-in QR code (the user scans it with the network's app: Klatchly itself signs nothing in). Never cached.
  routes.get('/qr/:source{[a-z0-9-]{1,32}}', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const q = await source.loginQR(c.req.param('source'));
      return q ? c.json(q satisfies QrReply) : c.json({ error: 'not_found' }, 404);
    } catch (e) {
      return fail(c, e, '/networks/qr/:source');
    }
  });

  return routes;
}

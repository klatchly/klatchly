import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { dataPath, jsonObject, log, type Env } from '#core/sdk.js';
import type { ExamplePrefs, HelloReply } from '../shapes.js';

// The space's API, mounted by the registry at /api/example/ (paths here are relative to it), behind the passkey
// session and the origin check, and answered only while the package is on. A route never trusts its input: the
// body is checked field by field, and anything else is a 400.
//
//   GET /api/example/hello   the greeting (KLATCHLY_EXAMPLE_GREETING, or null: the client then shows its own), when the
//                            package started, and how many calls the route got since then;
//   GET /api/example/prefs   the Settings page's preference;
//   PUT /api/example/prefs   { characters: boolean }: saved in the data volume (example.json).

const FILE = 'example.json';
const DEFAULT_PREFS: ExamplePrefs = { characters: false };

// The module's live state: set by start(), cleared by stop() (server/index.ts), so that turning the package off
// and on again in Settings → Extensions starts afresh and leaves nothing behind.
let startedAt: string | null = null;
let calls = 0;

export function started(): void {
  startedAt = new Date().toISOString();
  calls = 0;
}
export function stopped(): void {
  startedAt = null;
  calls = 0;
}

/** The optional greeting, trimmed and bounded (configuration is input too). Read when asked: no restart needed. */
export function greeting(): string | null {
  const g = process.env.KLATCHLY_EXAMPLE_GREETING?.trim();
  return g ? g.slice(0, 200) : null;
}

/** The stored preference; the default when the file is missing or not what we wrote. */
export function loadPrefs(): ExamplePrefs {
  try {
    const raw: unknown = JSON.parse(readFileSync(dataPath(FILE), 'utf8'));
    if (raw && typeof raw === 'object' && typeof (raw as ExamplePrefs).characters === 'boolean') return { characters: (raw as ExamplePrefs).characters };
  } catch {
    // Missing or unreadable: the default.
  }
  return { ...DEFAULT_PREFS };
}

function savePrefs(p: ExamplePrefs): void {
  // Write then rename: a crash never leaves half a file. 0600: the data volume is the app's alone.
  const path = dataPath(FILE);
  writeFileSync(`${path}.tmp`, JSON.stringify(p), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export const exampleRoutes = new Hono<Env>()
  .get('/hello', (c) => {
    calls++;
    return c.json({ greeting: greeting(), startedAt, calls } satisfies HelloReply);
  })
  .get('/prefs', (c) => c.json(loadPrefs()))
  .put('/prefs', async (c) => {
    const body = await jsonObject(c);
    if (!body || typeof body.characters !== 'boolean') return c.json({ error: 'bad_request' }, 400);
    const prefs: ExamplePrefs = { characters: body.characters };
    try {
      savePrefs(prefs);
    } catch {
      // Logs carry no user content: a scope, a short message, plain values.
      log('example', 'prefs save failed');
      return c.json({ error: 'save_failed' }, 500);
    }
    return c.json(prefs);
  });
